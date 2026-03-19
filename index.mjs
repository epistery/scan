import express from 'express';
import http from 'http';
import https from 'https';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import morgan from 'morgan';
import mongodb from 'mongodb';
import { readFileSync } from 'fs';
import { Config } from 'epistery';
import { Certify } from '@metric-im/administrate';
import Componentry from '@metric-im/componentry';
import Database from './db/Database.mjs';
import IngestionManager from './ingestion/IngestionManager.mjs';
import SearchHandler from './handlers/Search.mjs';
import MonitorHandler from './handlers/Monitor.mjs';
import EventHandler from './handlers/Event.mjs';
import FetchHandler from './handlers/Fetch.mjs';
import DiscoveryHandler from './handlers/Discovery.mjs';

const config = new Config();
await config.setPath('/');
const httpPort = process.env.PORT || 80;
const httpsPort = process.env.PORTSSL || 443;

// Load secrets from .secrets.json
let secrets = null;
try {
  secrets = JSON.parse(readFileSync('secrets.json', 'utf8'));
} catch (error) {
  console.warn('[scan] No secrets.json found, using config or defaults');
}

// Build MongoDB connection string based on PROFILE
function getMongoHost() {
  if (secrets?.mongo) {
    const profile = process.env.PROFILE || 'PROD';
    const host = profile === 'DEV' ? secrets.mongo.host_dev : secrets.mongo.host;
    const port = secrets.mongo.port || 27017;
    const database = secrets.mongo.database || 'epistery-scan';
    const username = secrets.mongo.username;
    const password = secrets.mongo.password;

    if (username && password) {
      return `mongodb://${username}:${password}@${host}:${port}/${database}?authSource=admin&directConnection=true`;
    } else {
      return `mongodb://${host}:${port}/${database}`;
    }
  }

  return config.data.mongoHost || 'mongodb://localhost:27017/epistery-scan';
}

const mongoHost = getMongoHost();
console.log(`[scan] MongoDB mode: ${process.env.MODE || 'PROD'}`);

/**
 * Epistery Scan Server
 *
 * Cross-chain blockchain event tracking and analytics for the Epistery ecosystem.
 * This is a standalone server (not an agent) that manages its own database.
 */
class EpisteryScan {
  constructor() {
    this.app = express();
    this.db = null;
    this.connector = null;
    this.database = null;
    this.ingestion = null;
  }

  async initialize() {
    // Connect to MongoDB
    console.log(`[scan] Connecting to ${mongoHost}...`);
    const client = await mongodb.MongoClient.connect(mongoHost, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    this.db = client.db();
    console.log(`[scan] Connected to MongoDB`);

    // Setup connector for componentry and metric-server patterns
    this.connector = {
      db: this.db,
      idForge: Componentry.IdForge,
      profile: { mongo: { host: mongoHost } }
    };

    // Initialize database layer
    this.database = new Database(this.connector);
    await this.database.initialize();

    // Initialize ingestion manager — chain RPC urls must come from ~/.epistery/config
    if (!config.data.chains) {
      throw new Error('[scan] No chains configured. Set [chains.*] in ~/.epistery/config');
    }

    const ingestionConfig = { chains: {}, pollInterval: config.data.pollInterval || 300000 };

    for (const [name, chain] of Object.entries(config.data.chains)) {
      if (!chain.rpcUrl) {
        console.warn(`[scan] Chain ${name} has no rpcUrl configured, skipping`);
        continue;
      }
      ingestionConfig.chains[name] = {
        enabled: chain.enabled !== false,
        rpcUrl: chain.rpcUrl
      };
    }

    this.ingestion = new IngestionManager(this.database, ingestionConfig);
    await this.ingestion.initialize();

    // Start ingestion polling
    const autostart = config.data.ingestion?.autostart ?? true;
    if (autostart) {
      this.ingestion.start();
    }

    // Setup Express middleware
    this.app.use(morgan('dev'));
    this.app.use(cors());
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(cookieParser());

    // Serve static files for UI
    this.app.use('/static', express.static('public'));

    // Create handlers
    const searchHandler = new SearchHandler(this.connector);
    const monitorHandler = new MonitorHandler(this.connector);
    const eventHandler = new EventHandler(this.connector);
    const fetchHandler = new FetchHandler(this.connector);
    const discoveryHandler = new DiscoveryHandler(this.connector);

    // Link handlers to ingestion
    monitorHandler.setIngestion(this.ingestion);
    searchHandler.setIngestion(this.ingestion);
    fetchHandler.setIngestion(this.ingestion);
    discoveryHandler.setDomainDiscovery(this.ingestion.domainDiscovery);

    // Mount API routes
    this.app.use('/api/search', searchHandler.routes());
    this.app.use('/api/monitor', monitorHandler.routes());
    this.app.use('/api/events', eventHandler.routes());
    this.app.use('/api/fetch', fetchHandler.routes());
    this.app.use('/api/discovery', discoveryHandler.routes());

    // Serve /.well-known/ai discovery manifest
    this.app.get('/.well-known/ai', async (req, res) => {
      try {
        const [domainCount, monitorCount, eventCount] = await Promise.all([
          this.db.collection('entities').countDocuments({ type: 'AIDiscovery' }),
          this.db.collection('monitors').countDocuments({ active: true }),
          this.db.collection('events').estimatedDocumentCount()
        ]);

        const host = req.hostname;
        const manifest = {
          specVersion: '1.2.0',
          standard: 'ai-discovery',
          generated: new Date().toISOString(),
          organization: {
            name: 'Epistery Scan',
            domain: host,
            description: 'Cross-chain blockchain explorer and AI discovery indexer for the Epistery ecosystem'
          },
          capabilities: {
            knowledge: false,
            feed: false,
            query: {
              available: true,
              url: '/api/search',
              auth: 'none',
              description: 'Search contracts, transactions, and AI discovery domains'
            }
          },
          apis: {
            search: {
              url: '/api/search?q={query}',
              method: 'GET',
              description: 'Search by address, tx hash, or domain. Returns entity type, chain, metadata.'
            },
            discovery: {
              url: '/api/discovery',
              methods: ['GET', 'POST'],
              description: 'GET lists indexed domains. POST {domain} to submit a new domain for indexing.'
            },
            discoveryDetail: {
              url: '/api/discovery/{domain}',
              method: 'GET',
              description: 'Full manifest and crawl state for a specific domain.'
            },
            events: {
              url: '/api/events',
              method: 'GET',
              description: 'Query blockchain events by entityId, type, chain.'
            },
            monitor: {
              url: '/api/monitor',
              methods: ['GET', 'POST'],
              description: 'List or add monitored blockchain contracts.'
            }
          },
          stats: {
            indexedDomains: domainCount,
            monitoredContracts: monitorCount,
            totalEvents: eventCount
          },
          coreConcepts: [
            { term: 'AI Discovery', definition: 'Web standard where domains publish /.well-known/ai manifests for AI agent consumption' },
            { term: 'DomainAgent', definition: 'Blockchain contract that links a domain name to an on-chain identity' },
            { term: 'IdentityContract', definition: 'Multi-sig identity binding using rivets and thresholds' },
            { term: 'CampaignWallet', definition: 'Smart contract managing ad campaign budgets and publisher payouts' }
          ],
          instructions: {
            forAI: 'You are interacting with Epistery Scan, a blockchain and AI discovery indexer. Use the /api/search endpoint to find contracts and domains. Use /api/discovery to list or submit domains with /.well-known/ai manifests. All responses are JSON. No authentication required for read operations.',
            rateLimit: 'Be respectful. 100 requests/minute for API. Do not scrape the HTML page — use the APIs.'
          },
          contact: {
            website: 'https://epistery.io'
          }
        };

        res.setHeader('Content-Type', 'application/json');
        res.json(manifest);
      } catch (err) {
        console.error('[scan] /.well-known/ai error:', err.message);
        res.status(500).json({ error: 'Failed to generate manifest' });
      }
    });

    // Serve robots.txt — steer bots to API, not HTML
    this.app.get('/robots.txt', (req, res) => {
      res.setHeader('Content-Type', 'text/plain');
      res.send([
        'User-agent: *',
        'Allow: /.well-known/ai',
        'Allow: /api/',
        'Disallow: /',
        '',
        'User-agent: GPTBot',
        'Allow: /.well-known/ai',
        'Allow: /api/',
        'Disallow: /',
        '',
        'User-agent: ClaudeBot',
        'Allow: /.well-known/ai',
        'Allow: /api/',
        'Disallow: /'
      ].join('\n'));
    });

    // Rate limiter for HTML page — 30 requests/minute per IP
    const htmlRateLimit = new Map();
    const HTML_RATE_WINDOW = 60000;
    const HTML_RATE_MAX = 30;

    // Serve discovery page
    this.app.get('/discovery', (req, res) => {
      res.setHeader('X-Robots-Tag', 'noindex');
      res.sendFile('public/discovery.html', { root: '.' });
    });

    // Serve main UI page with rate limiting and X-Robots-Tag
    this.app.get('/', (req, res) => {
      const ip = req.ip || req.connection.remoteAddress;
      const now = Date.now();
      const record = htmlRateLimit.get(ip);

      if (record && now - record.start < HTML_RATE_WINDOW) {
        record.count++;
        if (record.count > HTML_RATE_MAX) {
          res.setHeader('X-Robots-Tag', 'noindex');
          return res.status(429).json({
            error: 'Too many requests',
            message: 'Use the API instead. See /.well-known/ai for available endpoints.'
          });
        }
      } else {
        htmlRateLimit.set(ip, { start: now, count: 1 });
      }

      // Clean stale entries periodically
      if (htmlRateLimit.size > 10000) {
        for (const [key, val] of htmlRateLimit) {
          if (now - val.start > HTML_RATE_WINDOW) htmlRateLimit.delete(key);
        }
      }

      res.setHeader('X-Robots-Tag', 'noindex');
      res.sendFile('public/index.html', { root: '.' });
    });

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        service: 'epistery-scan',
        version: '1.0.0',
        database: this.db ? 'connected' : 'disconnected',
        ingestion: {
          running: this.ingestion?.isRunning || false,
          chains: Object.keys(this.ingestion?.connectors || {})
        }
      });
    });

    return this;
  }

  async start() {
    // Setup automatic SSL with administrate
    const certify = await Certify.attach(this.app,{contactEmail:secrets.contactEmail});

    // HTTPS server
    this.httpsServer = https.createServer({...certify.SNI}, this.app);
    this.httpsServer.listen(httpsPort);
    this.httpsServer.on('error', console.error);
    this.httpsServer.on('listening', () => {
      const address = this.httpsServer.address();
      console.log(`[scan] HTTPS server running on port ${address.port}`);
    });

    // HTTP server (for ACME challenges and redirects)
    this.httpServer = http.createServer(this.app);
    this.httpServer.listen(httpPort);
    this.httpServer.on('error', console.error);
    this.httpServer.on('listening', () => {
      const address = this.httpServer.address();
      console.log(`[scan] HTTP server running on port ${address.port}`);
    });

    console.log(`[scan] Epistery Scan initialized`);
    console.log(`[scan] Health check: http://localhost:${httpPort}/health`);
  }

  async shutdown() {
    console.log('[scan] Shutting down...');
    if (this.ingestion) {
      this.ingestion.stop();
    }

    // Close servers gracefully
    const closeServer = (server, name) => {
      return new Promise((resolve) => {
        if (!server) return resolve();
        server.close(() => {
          console.log(`[scan] ${name} server closed`);
          resolve();
        });
      });
    };

    await closeServer(this.httpsServer, 'HTTPS');
    await closeServer(this.httpServer, 'HTTP');
  }
}

// Start the server
const server = new EpisteryScan();
await server.initialize();
await server.start();

// Graceful shutdown
process.on('SIGINT', async () => {
  await server.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await server.shutdown();
  process.exit(0);
});

export default EpisteryScan;
