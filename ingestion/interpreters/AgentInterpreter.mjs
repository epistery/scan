/**
 * AgentInterpreter
 *
 * Interprets Agent.sol contracts - domain hosts that manage access lists and agent attributes.
 * Location: /rootz/epistery/contracts/Agent.sol
 */
export default class AgentInterpreter {
  constructor(connector, database) {
    this.connector = connector;
    this.database = database;
    this.type = 'Agent';

    // Minimal ABI for Agent contract
    this.abi = [
      'event AccessGranted(address indexed user, string listName)',
      'event AccessRevoked(address indexed user, string listName)',
      'event AttributeSet(string key, string value)',
      'function domain() view returns (string)',
      'function owner() view returns (address)',
      'function isListed(address user, string listName) view returns (bool)'
    ];
  }

  /**
   * Get events to monitor for this contract type
   */
  getEventFilters() {
    return [
      'AccessGranted(address indexed user, string listName)',
      'AccessRevoked(address indexed user, string listName)',
      'AttributeSet(string key, string value)'
    ];
  }

  /**
   * Sync a contract - read current state and record as entity
   */
  async syncContract(address, chain) {
    const connector = this.connector[chain];
    if (!connector) throw new Error(`No connector for chain: ${chain}`);

    try {
      const contract = connector.getContract(address, this.abi);

      // Read contract state
      const domain = await contract.domain();
      const owner = await contract.owner();

      // Save entity
      const entity = await this.database.saveEntity({
        address,
        type: this.type,
        chain,
        metadata: {
          domain,
          owner
        }
      });

      console.log(`[interpreter:agent] Synced ${address} on ${chain}`);
      return entity;
    } catch (error) {
      console.error(`[interpreter:agent] Failed to sync ${address}:`, error.message);
      throw error;
    }
  }

  /**
   * Process events for this contract
   */
  async processEvents(address, chain, fromBlock, toBlock) {
    const connector = this.connector[chain];
    if (!connector) throw new Error(`No connector for chain: ${chain}`);

    const eventRecords = [];

    for (const eventFilter of this.getEventFilters()) {
      const events = await connector.queryEvents(address, eventFilter, fromBlock, toBlock);

      for (const event of events) {
        // Enrich with timestamp
        event.timestamp = await connector.getBlockTimestamp(event.blockNumber);

        // Create event record
        const record = {
          source: 'blockchain',
          entityId: address,
          type: `agent.${event.event}`,
          chain: chain,
          data: {
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash,
            ...event.args
          },
          timestamp: event.timestamp
        };

        eventRecords.push(record);
      }
    }

    // Bulk record events
    if (eventRecords.length > 0) {
      await this.database.recordEvents(eventRecords);
      console.log(`[interpreter:agent] Processed ${eventRecords.length} events for ${address}`);
    }

    return eventRecords;
  }

  /**
   * Get human-readable summary of entity
   */
  async getSummary(address, chain) {
    const entity = await this.database.getEntity(address);
    if (!entity) return null;

    const events = await this.database.getEntityEvents(address, { limit: 10 });

    return {
      address,
      type: this.type,
      chain,
      domain: entity.metadata?.domain,
      owner: entity.metadata?.owner,
      recentEvents: events.length,
      lastActivity: events[0]?.timestamp
    };
  }
}
