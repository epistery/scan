import { ChainConnectorFactory } from './ChainConnector.mjs';
import AgentInterpreter from './interpreters/AgentInterpreter.mjs';
import IdentityContractInterpreter from './interpreters/IdentityContractInterpreter.mjs';
import CampaignWalletInterpreter from './interpreters/CampaignWalletInterpreter.mjs';

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
    this.interpreters = {};
    this.pollInterval = config.pollInterval || 60000; // Default 1 minute
    this.isRunning = false;
  }

  /**
   * Initialize connectors and interpreters
   */
  async initialize() {
    // Create chain connectors
    this.connectors = await ChainConnectorFactory.createFromConfig(this.config);
    console.log(`[ingestion] Initialized connectors for chains: ${Object.keys(this.connectors).join(', ')}`);

    // Create interpreters
    this.interpreters = {
      Agent: new AgentInterpreter(this.connectors, this.database),
      IdentityContract: new IdentityContractInterpreter(this.connectors, this.database),
      CampaignWallet: new CampaignWalletInterpreter(this.connectors, this.database)
    };
    console.log(`[ingestion] Initialized interpreters: ${Object.keys(this.interpreters).join(', ')}`);

    // Initialize database
    await this.database.initialize();

    return this;
  }

  /**
   * Add a contract to monitor
   */
  async addMonitor(address, chain, type) {
    // Validate type
    if (!this.interpreters[type]) {
      throw new Error(`Unknown contract type: ${type}`);
    }

    // Add to monitors collection
    await this.database.addMonitor({
      address: address.toLowerCase(),
      chain,
      type,
      active: true,
      metadata: { addedAt: new Date() }
    });

    // Sync the contract immediately
    const interpreter = this.interpreters[type];
    await interpreter.syncContract(address, chain);

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

    for (const monitor of monitors) {
      try {
        await this.processMonitor(monitor);
      } catch (error) {
        console.error(`[ingestion] Error processing monitor ${monitor.address}:`, error.message);
      }
    }
  }

  /**
   * Process a single monitor
   */
  async processMonitor(monitor) {
    const interpreter = this.interpreters[monitor.type];
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
    const lastBlock = entity?.lastProcessedBlock || 0;
    const currentBlock = await connector.getCurrentBlock();

    if (currentBlock > lastBlock) {
      // Process new events
      await interpreter.processEvents(monitor.address, monitor.chain, lastBlock + 1, currentBlock);

      // Update last processed block
      await this.database.saveEntity({
        address: monitor.address,
        type: monitor.type,
        chain: monitor.chain,
        lastProcessedBlock: currentBlock,
        metadata: entity?.metadata || {}
      });
    }

    // Re-sync contract state
    await interpreter.syncContract(monitor.address, monitor.chain);
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
    console.log('[ingestion] Stopped polling');
  }

  /**
   * Get summary of a contract
   */
  async getSummary(address, chain) {
    const entity = await this.database.getEntity(address.toLowerCase());
    if (!entity) return null;

    const interpreter = this.interpreters[entity.type];
    if (!interpreter) return null;

    return await interpreter.getSummary(address.toLowerCase(), chain);
  }
}
