import { ChainConnectorFactory } from './ChainConnector.mjs';
import EntityTypeRegistry from './EntityTypeRegistry.mjs';
import AgentInterpreter from './interpreters/AgentInterpreter.mjs';
import IdentityContractInterpreter from './interpreters/IdentityContractInterpreter.mjs';
import CampaignWalletInterpreter from './interpreters/CampaignWalletInterpreter.mjs';
import AIDiscoveryInterpreter from './interpreters/AIDiscoveryInterpreter.mjs';

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
    this.registry.register('CampaignWallet', new CampaignWalletInterpreter(this.connectors, this.database), { source: 'blockchain' });

    // Register web interpreter
    const aiDiscovery = new AIDiscoveryInterpreter(this.database, {
      pollInterval: this.config.discoveryPollInterval || 86400000, // 24 hours
      seedDomains: this.config.seedDomains || ['rootz.global', 'findbet.com', 'libertyproject.com']
    });
    this.registry.register('AIDiscovery', aiDiscovery, { source: 'web' });
    this.domainDiscovery = aiDiscovery.domainDiscovery;

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

    // Add to monitors collection
    await this.database.addMonitor({
      address: address.toLowerCase(),
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

    if (currentBlock > startBlock) {
      // Process new events
      await interpreter.processEvents(monitor.address, monitor.chain, startBlock + 1, currentBlock);

      // Update last processed block
      await this.database.saveEntity({
        address: monitor.address,
        type: monitor.type,
        chain: monitor.chain,
        lastProcessedBlock: currentBlock,
        metadata: entity?.metadata || {}
      });
    }

    // Re-sync entity state
    await interpreter.sync(monitor.address, monitor.chain);
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
