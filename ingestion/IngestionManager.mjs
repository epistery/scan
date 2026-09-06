import { ChainConnectorFactory } from './ChainConnector.mjs';
import EntityTypeRegistry from './EntityTypeRegistry.mjs';
import AgentInterpreter from './interpreters/AgentInterpreter.mjs';
import IdentityContractInterpreter from './interpreters/IdentityContractInterpreter.mjs';
import CampaignWalletInterpreter from './interpreters/CampaignWalletInterpreter.mjs';
import AIDiscoveryInterpreter from './interpreters/AIDiscoveryInterpreter.mjs';
import DataSourceInterpreter from './interpreters/DataSourceInterpreter.mjs';
import AppDirectory from './AppDirectory.mjs';
import ObjectImporter from './ObjectImporter.mjs';

/**
 * IngestionManager
 *
 * Coordinates blockchain data ingestion across multiple chains and contract types.
 * Polls monitored addresses and processes their events.
 */
export default class IngestionManager {
  constructor(database, config) {
    this.database = database;
    this.config = config;
    this.connectors = {};
    this.registry = new EntityTypeRegistry();
    this.pollInterval = config.pollInterval || 60000; // Default 1 minute
    this.isRunning = false;
    this.domainDiscovery = null;
    this.appDirectory = null;
    this.objectImporter = null;
  }

  /**
   * Initialize connectors and interpreters
   */
  async initialize() {
    // Create chain connectors
    this.connectors = await ChainConnectorFactory.createFromConfig(this.config);
    console.log(`[ingestion] Initialized connectors for chains: ${Object.keys(this.connectors).join(', ')}`);

    // Register blockchain interpreters
    this.registry.register('Agent', new AgentInterpreter(this.connectors, this.database), { source: 'blockchain' });
    this.registry.register('IdentityContract', new IdentityContractInterpreter(this.connectors, this.database), { source: 'blockchain' });
    this.registry.register('CampaignWallet', new CampaignWalletInterpreter(this.connectors, this.database, { factory: this.config.adnet?.factory }), { source: 'blockchain' });

    // Register web interpreter
    const aiDiscovery = new AIDiscoveryInterpreter(this.database, {
      pollInterval: this.config.discoveryPollInterval || 86400000, // 24 hours
      seedDomains: this.config.seedDomains || ['epistery.com', 'rootz.global', 'geist.social', 'michael.sprague.com', 'findbet.com', 'libertyproject.com'],
      // Forwarded from the root config loaded (awaited) in index.mjs, so
      // DomainDiscovery doesn't re-read Config synchronously — which returns
      // empty against a remote authority (epistery ≥ 2.2). See DomainDiscovery.
      sources: this.config.sources,
      datasources: this.config.datasources
    });
    this.registry.register('AIDiscovery', aiDiscovery, { source: 'web' });
    this.domainDiscovery = aiDiscovery.domainDiscovery;

    // Register data source interpreter
    const dataSource = new DataSourceInterpreter(this.database, this.domainDiscovery);
    this.registry.register('DataSource', dataSource, { source: 'config' });

    // epistery-app directory — indexes named contracts + public sessions from
    // scan's `identities` collection (and, if configured, the app's HTTP API).
    this.appDirectory = new AppDirectory(this.database, {
      appBaseUrl: this.config.appBaseUrl,
      pollInterval: this.config.appPollInterval || 3600000
    });

    // Object importer — pulls each data source's catalog and normalizes every
    // object into the global signed-object index (see ObjectImporter.mjs).
    this.objectImporter = new ObjectImporter(this.database, this.domainDiscovery, {
      pollInterval: this.config.objectImportInterval || 21600000
    });

    console.log(`[ingestion] Registered types: ${this.registry.list().join(', ')}`);

    // Initialize database
    await this.database.initialize();

    return this;
  }

  /**
   * Add a contract to monitor
   */
  async addMonitor(address, chain, type) {
    // Validate type
    if (!this.registry.has(type)) {
      throw new Error(`Unknown entity type: ${type}`);
    }

    // Lowercase throughout — the storage convention (see Database.saveEntity).
    // Passing the caller's checksummed form to sync() stamped mixed-case
    // entity/event ids while the poll loop used the lowercase monitor row.
    address = address.toLowerCase();

    // Add to monitors collection
    await this.database.addMonitor({
      address,
      chain,
      type,
      active: true,
      metadata: { addedAt: new Date() }
    });

    // Sync immediately
    const interpreter = this.registry.get(type);
    await interpreter.sync(address, chain);

    console.log(`[ingestion] Added monitor for ${type} at ${address} on ${chain}`);
  }

  /**
   * Remove a monitor
   */
  async removeMonitor(address, chain) {
    await this.database.deactivateMonitor(address.toLowerCase(), chain);
    console.log(`[ingestion] Removed monitor for ${address} on ${chain}`);
  }

  /**
   * Process all monitored contracts
   */
  async processMonitors() {
    const monitors = await this.database.getActiveMonitors();
    console.log(`[ingestion] Processing ${monitors.length} monitors...`);

    for (let i = 0; i < monitors.length; i++) {
      try {
        await this.processMonitor(monitors[i]);

        // Add delay between monitors to avoid rate limiting (1s for polygon)
        if (i < monitors.length - 1) {
          const delay = monitors[i].chain === 'polygon' ? 1000 : 500;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      } catch (error) {
        console.error(`[ingestion] Error processing monitor ${monitors[i].address}:`, error.message);
      }
    }
  }

  /**
   * Process a single monitor
   */
  async processMonitor(monitor) {
    const interpreter = this.registry.get(monitor.type);
    if (!interpreter) {
      console.error(`[ingestion] No interpreter for type: ${monitor.type}`);
      return;
    }

    const connector = this.connectors[monitor.chain];
    if (!connector) {
      console.error(`[ingestion] No connector for chain: ${monitor.chain}`);
      return;
    }

    // Get last processed block from entity metadata
    const entity = await this.database.getEntity(monitor.address);

    // Start from deployment block if known, otherwise use a recent block to avoid scanning all history
    // For new monitors without deployment info, start from 1000 blocks ago
    let startBlock = entity?.lastProcessedBlock;
    if (!startBlock) {
      const currentBlock = await connector.getCurrentBlock();
      // If we don't know deployment block, only scan recent history (last 100k blocks or contract deployment)
      startBlock = entity?.deploymentBlock || Math.max(0, currentBlock - 100000);
    }

    const currentBlock = await connector.getCurrentBlock();

    let records = null;
    if (currentBlock > startBlock) {
      // Process new events
      records = await interpreter.processEvents(monitor.address, monitor.chain, startBlock + 1, currentBlock);

      // Update last processed block
      await this.database.saveEntity({
        address: monitor.address,
        type: monitor.type,
        chain: monitor.chain,
        lastProcessedBlock: currentBlock,
        metadata: entity?.metadata || {}
      });
    }

    // Re-sync entity state — but only when it can have changed. On-chain state
    // changes always emit an event, so a chain scan that returned zero events
    // means nothing to re-read. sync() is 5–20 view calls per contract; on a
    // busy chain the head advances every poll, so gating on EVENTS (not on new
    // blocks) is what actually removes the idle RPC baseline.
    //
    // We only skip when processEvents actually ran as a chain scan (returned an
    // array). Interpreters whose processEvents isn't a chain scan (HTTP-based,
    // returns undefined) are never gated, and a never-synced entity always gets
    // one initial sync to populate its state.
    const scannedChain = Array.isArray(records);
    const eventCount = scannedChain ? records.length : 0;
    const needsInitialSync = !entity || entity.lastProcessedBlock == null;
    if (!scannedChain || eventCount > 0 || needsInitialSync) {
      await interpreter.sync(monitor.address, monitor.chain);
    }
  }

  /**
   * Start polling
   */
  start() {
    if (this.isRunning) {
      console.warn('[ingestion] Already running');
      return;
    }

    this.isRunning = true;
    console.log(`[ingestion] Starting polling (interval: ${this.pollInterval}ms)`);

    this.pollTimer = setInterval(async () => {
      try {
        await this.processMonitors();
      } catch (error) {
        console.error('[ingestion] Poll error:', error);
      }
    }, this.pollInterval);

    // Run immediately
    this.processMonitors().catch(error => {
      console.error('[ingestion] Initial poll error:', error);
    });

    // Start domain discovery on its own timer
    this.domainDiscovery.start();

    // Start the epistery-app directory sync on its own timer
    this.appDirectory?.start();

    // Start periodic object import (initial run kicks off immediately)
    this.objectImporter?.start();
  }

  /**
   * Import normalized objects from data source catalogs into the global index.
   * Safe to call regardless of whether periodic ingestion is running — used by
   * the manual /api/ingest trigger. `name` limits to one source; `cap` bounds
   * objects per source.
   */
  async importObjects({ name = null, cap = Infinity } = {}) {
    if (!this.objectImporter) throw new Error('Object importer not initialized');
    return this.objectImporter.importAll({ name, cap });
  }

  /**
   * Stop polling
   */
  stop() {
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.domainDiscovery) {
      this.domainDiscovery.stop();
    }
    this.appDirectory?.stop();
    this.objectImporter?.stop();
    console.log('[ingestion] Stopped polling');
  }

  /**
   * Get summary of a contract
   */
  async getSummary(address, chain) {
    const entity = await this.database.getEntity(address.toLowerCase());
    if (!entity) return null;

    const interpreter = this.registry.get(entity.type);
    if (!interpreter) return null;

    return await interpreter.getSummary(address.toLowerCase(), chain);
  }
}
