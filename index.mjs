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
 * Runs as an epistery-host agent. Connects to localhost MongoDB independently.
 */
export default class EpisteryScan {
  constructor(config = {}) {
    this.config = config;
    this.db = null;
    this.connector = null;
    this.database = null;
    this.ingestion = null;
  }

  async attach(router) {
    // Connect to MongoDB — localhost, independent
    const mongoHost = `mongodb://localhost:27017/${DB_NAME}`;
    console.log(`[epistery-scan] Connecting to ${mongoHost}...`);
    const client = await mongodb.MongoClient.connect(mongoHost);
    this.db = client.db();
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
    this.ingestion.start();

    // Static files
    router.use('/static', express.static(path.join(__dirname, 'public')));

    // Create handlers
    const searchHandler = new SearchHandler(this.connector);
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
