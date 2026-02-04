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

const config = new Config();
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
  if (secrets?.mongodb) {
    const profile = process.env.PROFILE || 'PROD';
    const host = profile === 'DEV' ? secrets.mongodb.host_dev : secrets.mongodb.host;
    const port = secrets.mongodb.port || 27017;
    const database = secrets.mongodb.database || 'epistery-scan';
    const username = secrets.mongodb.username;
    const password = secrets.mongodb.password;

    if (username && password) {
      return `mongodb://${username}:${password}@${host}:${port}/${database}?authSource=admin`;
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
    this.config = new Config();
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

    // Initialize ingestion manager
    const ingestionConfig = {
      chains: {
        ethereum: {
          enabled: config.data.chains?.ethereum?.enabled !== false,
          rpcUrl: config.data.chains?.ethereum?.rpcUrl || 'https://eth.llamarpc.com'
        },
        polygon: {
          enabled: config.data.chains?.polygon?.enabled !== false,
          rpcUrl: config.data.chains?.polygon?.rpcUrl || 'https://polygon-rpc.com'
        },
        'polygon-amoy': {
          enabled: config.data.chains?.['polygon-amoy']?.enabled !== false,
          rpcUrl: config.data.chains?.['polygon-amoy']?.rpcUrl || 'https://rpc-amoy.polygon.technology'
        }
      },
      pollInterval: config.data.pollInterval || 300000 // 5 minutes for dev pace
    };

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

    // Link handlers to ingestion
    monitorHandler.setIngestion(this.ingestion);
    searchHandler.setIngestion(this.ingestion);
    fetchHandler.setIngestion(this.ingestion);

    // Mount API routes
    this.app.use('/api/search', searchHandler.routes());
    this.app.use('/api/monitor', monitorHandler.routes());
    this.app.use('/api/events', eventHandler.routes());
    this.app.use('/api/fetch', fetchHandler.routes());

    // Serve main UI page
    this.app.get('/', (req, res) => {
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
    const certify = await Certify.attach(this.app);

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
