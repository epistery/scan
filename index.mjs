import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import mongodb from 'mongodb';
import { Config } from 'epistery';
import Componentry from '@metric-im/componentry';
import Database from './db/Database.mjs';
import IngestionManager from './ingestion/IngestionManager.mjs';
import SearchHandler from './handlers/Search.mjs';
import MonitorHandler from './handlers/Monitor.mjs';
import EventHandler from './handlers/Event.mjs';
import FetchHandler from './handlers/Fetch.mjs';
import DiscoveryHandler from './handlers/Discovery.mjs';
import FeedHandler from './handlers/Feed.mjs';
import Harness from './lib/Harness.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_NAME = 'epistery-scan';

/**
 * Epistery Scan — Search the Signed Web
 *
 * Epistery agent that indexes websites publishing authored, cryptographically
 * signed data via the AI Discovery Standard (/.well-known/ai). Provides
 * knowledge search across what organizations have published and signed.
 *
 * Runs as an epistery-host agent.
 *
 * MongoDB connection priority:
 *   1. config.mongoHost (explicit via epistery.json config)
 *   2. OCI Vault — metric-im shared cluster (10.0.0.112 PROD / 129.159.123.39 DEV)
 *   3. localhost MongoDB
 */
async function resolveMongoHost(config) {
  // 1. Explicit config wins
  if (config.mongoHost) return config.mongoHost;

  // 2. OCI Vault — metric-im cluster. METRIC profile reads metric-secrets bundle.
  const profile = process.env.PROFILE || 'PROD';
  try {
    const { secrets: ociSecrets, ConfigFileAuthenticationDetailsProvider } = await import('oci-sdk');
    const ociProfile = process.env.OCI_PROFILE || 'METRIC';
    const provider = new ConfigFileAuthenticationDetailsProvider(
      process.env.OCI_CONFIG_PATH || '~/.oci/config',
      ociProfile
    );
    const client = new ociSecrets.SecretsClient({ authenticationDetailsProvider: provider });
    const response = await client.getSecretBundleByName({
      secretName: process.env.OCI_SECRET_NAME,
      vaultId: process.env.OCI_VAULT_NAME
    });
    const { content } = response.secretBundle.secretBundleContent;
    const vault = JSON.parse(Buffer.from(content, 'base64').toString());

    if (vault.MONGO_PASS_METRIC) {
      const host = profile === 'DEV' ? '129.159.123.39' : '10.0.0.112';
      return `mongodb://metric:${vault.MONGO_PASS_METRIC}@${host}:27017/${DB_NAME}?authSource=admin&directConnection=true`;
    }
  } catch (e) {
    console.warn(`[epistery-scan] OCI Vault unavailable: ${e.message}`);
  }

  // 3. Localhost fallback
  return `mongodb://localhost:27017/${DB_NAME}`;
}

export default class EpisteryScan {
  constructor(config = {}) {
    this.config = config;
    this.db = null;
    this.connector = null;
    this.database = null;
    this.ingestion = null;
  }

  async attach(router) {
    const mongoHost = await resolveMongoHost(this.config);
    const safeMongo = mongoHost.replace(/\/\/[^@]+@/, '//<credentials>@');
    console.log(`[epistery-scan] Connecting to ${safeMongo}...`);
    const client = await mongodb.MongoClient.connect(mongoHost);
    this.db = client.db(DB_NAME);
    console.log(`[epistery-scan] Connected to MongoDB`);

    // Connector for handler pattern
    this.connector = {
      db: this.db,
      idForge: Componentry.IdForge
    };

    // Initialize database layer
    this.database = new Database(this.connector);
    await this.database.initialize();

    // Initialize ingestion — chain config optional, domain discovery is core
    const episteryConfig = new Config();
    await episteryConfig.setPath('/');

    const ingestionConfig = {
      chains: {},
      pollInterval: episteryConfig.data.pollInterval || 300000
    };

    // Chain RPC URLs from epistery config (optional — domain discovery works without them)
    if (episteryConfig.data.chains) {
      for (const [name, chain] of Object.entries(episteryConfig.data.chains)) {
        if (!chain.rpcUrl) continue;
        ingestionConfig.chains[name] = {
          enabled: chain.enabled !== false,
          rpcUrl: chain.rpcUrl
        };
      }
    }

    // Also check default.provider for Polygon
    if (Object.keys(ingestionConfig.chains).length === 0 && episteryConfig.data['default.provider']?.privateRpc) {
      ingestionConfig.chains.polygon = {
        enabled: true,
        rpcUrl: episteryConfig.data['default.provider'].privateRpc
      };
    }

    this.ingestion = new IngestionManager(this.database, ingestionConfig);
    await this.ingestion.initialize();

    const autostart = this.config.ingestion?.autostart
      ?? episteryConfig.data.ingestion?.autostart
      ?? false;
    if (autostart) {
      this.ingestion.start();
    } else {
      console.log(`[epistery-scan] Ingestion autostart disabled — no automatic RPC polling. Set ingestion.autostart=true in ~/.epistery/config to enable.`);
    }

    // Static files
    router.use('/static', express.static(path.join(__dirname, 'public')));

    // Create handlers
    const searchHandler = new SearchHandler(this.connector, this.harness);
    const monitorHandler = new MonitorHandler(this.connector);
    const eventHandler = new EventHandler(this.connector);
    const fetchHandler = new FetchHandler(this.connector);
    const discoveryHandler = new DiscoveryHandler(this.connector);
    const feedHandler = new FeedHandler(this.connector);

    // Link handlers to ingestion
    searchHandler.setIngestion(this.ingestion);
    monitorHandler.setIngestion(this.ingestion);
    fetchHandler.setIngestion(this.ingestion);
    feedHandler.setIngestion(this.ingestion);
    discoveryHandler.setDomainDiscovery(this.ingestion.domainDiscovery);

    // Mount API routes
    router.use('/api/search', searchHandler.routes());
    router.use('/api/monitor', monitorHandler.routes());
    router.use('/api/events', eventHandler.routes());
    router.use('/api/fetch', fetchHandler.routes());
    router.use('/api/discovery', discoveryHandler.routes());
    router.use('/api/feed', feedHandler.routes());

    // Health check
    router.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        service: 'epistery-scan',
        description: 'Search the signed web',
        version: '2.0.0',
        database: this.db ? 'connected' : 'disconnected',
        ingestion: {
          running: this.ingestion?.isRunning || false,
          chains: Object.keys(this.ingestion?.connectors || {}),
          discovery: this.ingestion?.domainDiscovery?.isRunning || false
        }
      });
    });

    // Agent icon
    router.get('/icon.svg', (req, res) => {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="45" fill="#2c3e50" stroke="#3498db" stroke-width="3"/>
        <text x="50" y="58" text-anchor="middle" fill="white" font-size="36" font-family="sans-serif">&#x1F50D;</text>
      </svg>`);
    });

    // Search page — the main UI
    router.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'public/index.html'));
    });

    // Discovery page
    router.get('/discovery', (req, res) => {
      res.sendFile(path.join(__dirname, 'public/discovery.html'));
    });

    console.log(`[epistery-scan] Agent attached — search the signed web`);
  }
}

// ---- Standalone bootstrap ----
// When this file is executed directly (`node index.mjs`, i.e. the systemd unit
// running `npm start`), boot a full HTTP/HTTPS server. When imported as an
// epistery-host agent, the class export above is used instead and this block
// does not run.
if (import.meta.url === (await import('url')).pathToFileURL(process.argv[1]).href) {
  const [
    http,
    https,
    { default: cookieParser },
    { default: cors },
    { default: morgan },
    { readFileSync },
    { Epistery },
    { Certify }
  ] = await Promise.all([
    import('http'),
    import('https'),
    import('cookie-parser'),
    import('cors'),
    import('morgan'),
    import('fs'),
    import('epistery'),
    import('@metric-im/administrate')
  ]);

  const httpPort = process.env.PORT || 80;
  const httpsPort = process.env.PORTSSL || 443;

  let secrets = null;
  try {
    secrets = JSON.parse(readFileSync(path.join(__dirname, 'secrets.json'), 'utf8'));
  } catch (err) {
    console.warn('[scan] No secrets.json found, using config or defaults');
  }

  const app = express();
  app.use(morgan('dev'));
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  // Harness — spawn child processes for hostname-routed services
  const harnessConfig = new Config();
  harnessConfig.setPath('/');
  const harnessMap = harnessConfig.data.harness || {};
  const harness = new Harness(harnessMap);
  if (Object.keys(harnessMap).length) {
    await harness.start();
    app.use(harness.middleware());
  }

  // Epistery middleware — every visitor gets a device wallet
  const epistery = await Epistery.connect();
  await epistery.attach(app);
  app.locals.epistery = epistery;

  // Robots.txt — steer bots to /api and /.well-known/ai
  app.get('/robots.txt', (req, res) => {
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

  // Build Mongo URL from secrets.json if present — matches the original
  // standalone's `getMongoHost()` contract. Falls through to attach()'s
  // OCI Vault / localhost chain when no secrets.mongo block is configured.
  let mongoHost;
  if (secrets?.mongo) {
    const profile = process.env.PROFILE || 'PROD';
    const host = profile === 'DEV' ? (secrets.mongo.host_dev || secrets.mongo.host) : secrets.mongo.host;
    const port = secrets.mongo.port || 27017;
    const database = secrets.mongo.database || 'epistery-scan';
    const { username, password } = secrets.mongo;
    mongoHost = username && password
      ? `mongodb://${username}:${password}@${host}:${port}/${database}?authSource=admin&directConnection=true`
      : `mongodb://${host}:${port}/${database}`;
  }

  const scan = new EpisteryScan(mongoHost ? { mongoHost } : {});
  scan.harness = harness;
  await scan.attach(app);

  // AI Discovery manifest — describes scan itself to AI agents
  app.get('/.well-known/ai', async (req, res) => {
    try {
      const [domainCount, monitorCount, eventCount] = await Promise.all([
        scan.db.collection('entities').countDocuments({ type: 'AIDiscovery' }),
        scan.db.collection('monitors').countDocuments({ active: true }),
        scan.db.collection('events').estimatedDocumentCount()
      ]);

      res.setHeader('Content-Type', 'application/json');
      res.json({
        specVersion: '1.2.0',
        standard: 'ai-discovery',
        generated: new Date().toISOString(),
        organization: {
          name: 'Epistery Scan',
          domain: req.hostname,
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
          search: { url: '/api/search?q={query}', method: 'GET', description: 'Search by address, tx hash, or domain.' },
          discovery: { url: '/api/discovery', methods: ['GET', 'POST'], description: 'GET lists indexed domains. POST {domain} to submit a new domain for indexing.' },
          discoveryDetail: { url: '/api/discovery/{domain}', method: 'GET', description: 'Full manifest and crawl state for a specific domain.' },
          events: { url: '/api/events', method: 'GET', description: 'Query blockchain events by entityId, type, chain.' },
          monitor: { url: '/api/monitor', methods: ['GET', 'POST'], description: 'List or add monitored blockchain contracts.' }
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
          forAI: 'You are interacting with Epistery Scan, a blockchain and AI discovery indexer. Use the /api/search endpoint to find contracts and domains. Use /api/discovery to list or submit domains with /.well-known/ai manifests. All responses are JSON.',
          rateLimit: 'Be respectful. 100 requests/minute for API. Do not scrape the HTML page — use the APIs.'
        },
        contact: { website: `https://${req.hostname}` }
      });
    } catch (err) {
      console.error('[scan] /.well-known/ai error:', err.message);
      res.status(500).json({ error: 'Failed to generate manifest' });
    }
  });

  // Bring up listeners. Three modes:
  //   - UPSTREAM=1 (env): plain HTTP on $PORT only. TLS is terminated upstream
  //     (harness/MultiSite, nginx, etc.) — do not provision certs here.
  //   - contactEmail present: provision HTTPS via administrate on :443, HTTP on :80.
  //   - Neither: plain HTTP on $PORT || 3000 for dev clones without credentials.
  const upstream = process.env.UPSTREAM === '1' || process.env.UPSTREAM === 'true';
  const contactEmail = secrets?.contactEmail || process.env.CONTACT_EMAIL;
  const servers = [];

  if (upstream) {
    const upstreamPort = process.env.PORT || 3000;
    const httpServer = http.createServer(app);
    httpServer.on('error', console.error);
    httpServer.on('listening', () => console.log(`[scan] HTTP server on port ${httpServer.address().port} (UPSTREAM mode — TLS terminated by harness)`));
    httpServer.listen(upstreamPort);
    servers.push(httpServer);
  } else if (contactEmail) {
    const certify = await Certify.attach(app, { contactEmail });
    const httpsServer = https.createServer({ ...certify.SNI }, app);
    httpsServer.on('error', console.error);
    httpsServer.on('listening', () => console.log(`[scan] HTTPS server running on port ${httpsServer.address().port}`));
    httpsServer.listen(httpsPort);
    servers.push(httpsServer);

    const httpServer = http.createServer(app);
    httpServer.on('error', console.error);
    httpServer.on('listening', () => console.log(`[scan] HTTP server running on port ${httpServer.address().port}`));
    httpServer.listen(httpPort);
    servers.push(httpServer);
  } else {
    const devPort = process.env.PORT || 3000;
    const httpServer = http.createServer(app);
    httpServer.on('error', console.error);
    httpServer.on('listening', () => console.log(`[scan] HTTP server on port ${httpServer.address().port} (no HTTPS — set contactEmail in secrets.json to enable)`));
    httpServer.listen(devPort);
    servers.push(httpServer);
  }

  const shutdown = async (signal) => {
    console.log(`[scan] ${signal} received, shutting down...`);
    scan.ingestion?.stop();
    await harness.shutdown();
    await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
