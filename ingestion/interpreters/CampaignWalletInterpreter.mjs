/**
 * CampaignWalletInterpreter
 *
 * Interprets CampaignWallet.sol - operates ad campaigns in the Adnet network.
 * Location: /geistm/adnet-factory/contracts/CampaignWallet.sol
 */
export default class CampaignWalletInterpreter {
  constructor(connector, database) {
    this.connector = connector;
    this.database = database;
    this.type = 'CampaignWallet';

    // Minimal ABI for CampaignWallet
    this.abi = [
      'event CampaignCreated(address indexed creator, uint256 budget)',
      'event ImpressionRecorded(bytes32 indexed adId, address indexed publisher)',
      'event ClickRecorded(bytes32 indexed adId, address indexed publisher)',
      'event PaymentMade(address indexed publisher, uint256 amount)',
      'function owner() view returns (address)',
      'function budget() view returns (uint256)',
      'function spent() view returns (uint256)'
    ];
  }

  getEventFilters() {
    return [
      'CampaignCreated(address indexed creator, uint256 budget)',
      'ImpressionRecorded(bytes32 indexed adId, address indexed publisher)',
      'ClickRecorded(bytes32 indexed adId, address indexed publisher)',
      'PaymentMade(address indexed publisher, uint256 amount)'
    ];
  }

  async syncContract(address, chain) {
    const connector = this.connector[chain];
    if (!connector) throw new Error(`No connector for chain: ${chain}`);

    try {
      const contract = connector.getContract(address, this.abi);

      // Read contract state
      const owner = await contract.owner();
      const budget = await contract.budget();
      const spent = await contract.spent();

      // Save entity
      const entity = await this.database.saveEntity({
        address,
        type: this.type,
        chain,
        metadata: {
          owner: owner.toLowerCase(),
          budget: budget.toString(),
          spent: spent.toString()
        }
      });

      console.log(`[interpreter:campaign] Synced ${address} on ${chain}`);
      return entity;
    } catch (error) {
      console.error(`[interpreter:campaign] Failed to sync ${address}:`, error.message);
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
          type: `campaign.${event.event}`,
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
      console.log(`[interpreter:campaign] Processed ${eventRecords.length} events for ${address}`);
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
      owner: entity.metadata?.owner,
      budget: entity.metadata?.budget,
      spent: entity.metadata?.spent,
      recentEvents: events.length,
      lastActivity: events[0]?.timestamp
    };
  }
}
