/**
 * IdentityContractInterpreter
 *
 * Interprets IdentityContract.sol - binds multiple browser devices into a single identity (multisig).
 * Location: /rootz/epistery/contracts/IdentityContract.sol
 */
export default class IdentityContractInterpreter {
  constructor(connector, database) {
    this.connector = connector;
    this.database = database;
    this.type = 'IdentityContract';

    // Minimal ABI for IdentityContract
    this.abi = [
      'event RivetAdded(address indexed rivet)',
      'event RivetRemoved(address indexed rivet)',
      'event ThresholdChanged(uint256 threshold)',
      'function getRivets() view returns (address[])',
      'function threshold() view returns (uint256)',
      'function sponsor() view returns (address)'
    ];
  }

  getEventFilters() {
    return [
      'RivetAdded(address indexed rivet)',
      'RivetRemoved(address indexed rivet)',
      'ThresholdChanged(uint256 threshold)'
    ];
  }

  getSchema() {
    return { source: 'blockchain', tabs: ['overview', 'transactions', 'events', 'data'] };
  }

  async sync(address, chain) {
    const connector = this.connector[chain];
    if (!connector) throw new Error(`No connector for chain: ${chain}`);

    try {
      const contract = connector.getContract(address, this.abi);

      // Read contract state
      const rivets = await contract.getRivets();
      const threshold = await contract.threshold();
      const sponsor = await contract.sponsor();

      // Save entity
      const entity = await this.database.saveEntity({
        address,
        type: this.type,
        chain,
        metadata: {
          rivets: rivets.map(r => r.toLowerCase()),
          threshold: Number(threshold),
          sponsor: sponsor.toLowerCase()
        }
      });

      console.log(`[interpreter:identity] Synced ${address} on ${chain}`);
      return entity;
    } catch (error) {
      console.error(`[interpreter:identity] Failed to sync ${address}:`, error.message);
      throw error;
    }
  }

  async processEvents(address, chain, fromBlock, toBlock) {
    const connector = this.connector[chain];
    if (!connector) throw new Error(`No connector for chain: ${chain}`);

    const eventRecords = [];

    for (const eventFilter of this.getEventFilters()) {
      const events = await connector.queryEvents(address, eventFilter, fromBlock, toBlock);

      for (const event of events) {
        event.timestamp = await connector.getBlockTimestamp(event.blockNumber);

        const record = {
          source: 'blockchain',
          entityId: address,
          type: `identity.${event.event}`,
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

    if (eventRecords.length > 0) {
      await this.database.recordEvents(eventRecords);
      console.log(`[interpreter:identity] Processed ${eventRecords.length} events for ${address}`);
    }

    return eventRecords;
  }

  async getSummary(address, chain) {
    const entity = await this.database.getEntity(address);
    if (!entity) return null;

    const events = await this.database.getEntityEvents(address, { limit: 10 });

    return {
      address,
      type: this.type,
      chain,
      rivets: entity.metadata?.rivets,
      threshold: entity.metadata?.threshold,
      sponsor: entity.metadata?.sponsor,
      recentEvents: events.length,
      lastActivity: events[0]?.timestamp
    };
  }
}
