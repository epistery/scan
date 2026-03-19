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

    // Minimal ABI for DomainAgent contract
    this.abi = [
      'event ACLModified(address indexed owner, string listName, address indexed addr, string action, uint256 timestamp)',
      'event ApprovalRequested(address indexed approver, address indexed requestor, string fileName, string fileHash, uint256 timestamp)',
      'event ApprovalHandled(address indexed approver, address indexed requestor, string fileName, bool approved, uint256 timestamp)',
      'event AttributeSet(address indexed owner, string key, bool isPrivate, uint256 timestamp)',
      'event AttributeDeleted(address indexed owner, string key, bool isPrivate, uint256 timestamp)',
      'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner, uint256 timestamp)',
      'function VERSION() view returns (string)',
      'function domain() view returns (string)',
      'function sponsor() view returns (address)',
      'function owner() view returns (address)',
      'function isInACL(string listName, address addr) view returns (bool)',
      'function getACL(string listName) view returns (tuple(address addr, string name, uint8 role, string meta)[])',
      'function getListNames() view returns (string[])'
    ];
  }

  /**
   * Get events to monitor for this contract type
   */
  getEventFilters() {
    return [
      'ACLModified(address indexed owner, string listName, address indexed addr, string action, uint256 timestamp)',
      'ApprovalRequested(address indexed approver, address indexed requestor, string fileName, string fileHash, uint256 timestamp)',
      'ApprovalHandled(address indexed approver, address indexed requestor, string fileName, bool approved, uint256 timestamp)',
      'AttributeSet(address indexed owner, string key, bool isPrivate, uint256 timestamp)',
      'AttributeDeleted(address indexed owner, string key, bool isPrivate, uint256 timestamp)',
      'OwnershipTransferred(address indexed previousOwner, address indexed newOwner, uint256 timestamp)'
    ];
  }

  /**
   * Sync a contract - read current state and record as entity
   */
  getSchema() {
    return { source: 'blockchain', tabs: ['overview', 'transactions', 'events', 'data'] };
  }

  async sync(address, chain) {
    const connector = this.connector[chain];
    if (!connector) throw new Error(`No connector for chain: ${chain}`);

    try {
      const contract = connector.getContract(address, this.abi);
      const metadata = {};

      // Try to read owner (all contracts should have this)
      try {
        metadata.owner = await contract.owner();
      } catch (e) {
        console.log(`[interpreter:agent] No owner() for ${address}`);
      }

      // Try to read domain (only DomainAgent contracts have this)
      try {
        metadata.domain = await contract.domain();
      } catch (e) {
        // Not a DomainAgent, that's fine
      }

      // Try to read sponsor
      try {
        metadata.sponsor = await contract.sponsor();
      } catch (e) {
        // No sponsor, that's fine
      }

      // Try to read version
      try {
        metadata.version = await contract.VERSION();
      } catch (e) {
        // No version, that's fine
      }

      // Save entity
      const entity = await this.database.saveEntity({
        address,
        type: this.type,
        chain,
        metadata
      });

      console.log(`[interpreter:agent] Synced ${address} on ${chain}`, metadata);
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
      // Add delay between event queries to avoid rate limiting (500ms for polygon)
      if (eventRecords.length > 0) {
        const delay = chain === 'polygon' ? 500 : 200;
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      const events = await connector.queryEvents(address, eventFilter, fromBlock, toBlock);

      for (const event of events) {
        // Enrich with timestamp
        event.timestamp = await connector.getBlockTimestamp(event.blockNumber);

        // Debug: log event args
        if (Object.keys(event.args).length > 0) {
          console.log(`[interpreter:agent] Event ${event.event} args:`, event.args);
        }

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
      try {
        console.log(`[interpreter:agent] About to record ${eventRecords.length} events...`);
        const result = await this.database.recordEvents(eventRecords);
        console.log(`[interpreter:agent] Processed ${eventRecords.length} events for ${address}`);
      } catch (error) {
        console.error(`[interpreter:agent] Error recording events:`, error);
        throw error;
      }
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
