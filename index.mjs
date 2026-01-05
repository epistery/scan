import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import morgan from 'morgan';
import mongodb from 'mongodb';
import { Config } from 'epistery';
import Componentry from '@metric-im/componentry';
import Database from './db/Database.mjs';
import IngestionManager from './ingestion/IngestionManager.mjs';
import SearchHandler from './handlers/Search.mjs';
import MonitorHandler from './handlers/Monitor.mjs';
import EventHandler from './handlers/Event.mjs';

const config = new Config();
const port = process.env.PORT || 3000;
const rootConfigData = config.read('/');
const mongoHost = rootConfigData.mongoHost || 'mongodb://localhost:27017/epistery-scan';

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

    // Initialize ingestion manager
    const ingestionConfig = {
      chains: {
        ethereum: {
          enabled: config.get('chains.ethereum.enabled') !== false,
          rpcUrl: config.get('chains.ethereum.rpcUrl') || 'https://eth.llamarpc.com'
        },
        polygon: {
          enabled: config.get('chains.polygon.enabled') || false,
          rpcUrl: config.get('chains.polygon.rpcUrl') || 'https://polygon-rpc.com'
        }
      },
      pollInterval: config.get('pollInterval') || 60000
    };

    this.ingestion = new IngestionManager(this.database, ingestionConfig);
    await this.ingestion.initialize();

    // Start ingestion polling
    if (config.get('ingestion.autostart') !== false) {
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

    // Link monitor handler to ingestion
    monitorHandler.setIngestion(this.ingestion);

    // Mount API routes
    this.app.use('/api/search', searchHandler.routes());
    this.app.use('/api/monitor', monitorHandler.routes());
    this.app.use('/api/events', eventHandler.routes());

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
    this.app.listen(port, () => {
      console.log(`[scan] Epistery Scan running on http://localhost:${port}`);
      console.log(`[scan] Health check: http://localhost:${port}/health`);
    });
  }

  async shutdown() {
    console.log('[scan] Shutting down...');
    if (this.ingestion) {
      this.ingestion.stop();
    }
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
