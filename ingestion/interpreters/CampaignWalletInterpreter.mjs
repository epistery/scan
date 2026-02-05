/**
 * CampaignWalletInterpreter
 *
 * Interprets CampaignWallet.sol v2 contracts - advertising campaigns in the Adnet ecosystem.
 * Location: /geistm/adnet-factory-v2/contracts/CampaignWallet.sol
 */
export default class CampaignWalletInterpreter {
  constructor(connector, database) {
    this.connector = connector;
    this.database = database;
    this.type = 'CampaignWallet';

    // Minimal ABI for CampaignWallet v2 contract
    this.abi = [
      'event BatchSubmitted(address indexed publisher, string ipfsCID, uint256 payout, bytes32 lastHash)',
      'event Withdrawn(address indexed publisher, uint256 amount)',
      'event PromotionAdded(string promotionId, string creative)',
      'event PromotionUpdated(uint256 indexed index, bool active)',
      'event CampaignPaused(address indexed by)',
      'event CampaignUnpaused(address indexed by)',
      'event BudgetAdded(address indexed from, uint256 amount)',
      'function name() view returns (string)',
      'function advertiser() view returns (string, address)',
      'function agency() view returns (address)',
      'function active() view returns (bool)',
      'function getPromotionCount() view returns (uint256)'
    ];
  }

  /**
   * Get events to monitor for this contract type
   */
  getEventFilters() {
    return [
      'BatchSubmitted(address indexed publisher, string ipfsCID, uint256 payout, bytes32 lastHash)',
      'Withdrawn(address indexed publisher, uint256 amount)',
      'PromotionAdded(string promotionId, string creative)',
      'PromotionUpdated(uint256 indexed index, bool active)',
      'CampaignPaused(address indexed by)',
      'CampaignUnpaused(address indexed by)',
      'BudgetAdded(address indexed from, uint256 amount)'
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
      const metadata = {};

      // Read campaign attributes (v2)
      try { metadata.name = await contract.name(); } catch (e) {}
      try {
        const advertiserData = await contract.advertiser();
        metadata.advertiser = {
          name: advertiserData[0],
          wallet: advertiserData[1]
        };
      } catch (e) {}
      try { metadata.agency = await contract.agency(); } catch (e) {}
      try { metadata.active = await contract.active(); } catch (e) {}
      try { metadata.promotionCount = (await contract.getPromotionCount()).toString(); } catch (e) {}

      // Save entity
      const entity = await this.database.saveEntity({
        address,
        type: this.type,
        chain,
        metadata
      });

      console.log(`[interpreter:campaign] Synced ${address} on ${chain}`, metadata);
      return entity;
    } catch (error) {
      console.error(`[interpreter:campaign] Failed to sync ${address}:`, error.message);
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
      // Add delay between event queries to avoid rate limiting
      if (eventRecords.length > 0) {
        const delay = chain === 'polygon' ? 500 : 200;
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      const events = await connector.queryEvents(address, eventFilter, fromBlock, toBlock);

      for (const event of events) {
        // Enrich with timestamp
        event.timestamp = await connector.getBlockTimestamp(event.blockNumber);

        const record = {
          type: `campaign.${event.eventName}`,
          source: 'CampaignWallet',
          entityId: address,
          chain,
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
          timestamp: event.timestamp
        };

        // Parse event-specific data (v2)
        if (event.eventName === 'BatchSubmitted') {
          record.publisher = event.args.publisher;
          record.ipfsCID = event.args.ipfsCID;
          record.payout = event.args.payout.toString();
          record.lastHash = event.args.lastHash;
        } else if (event.eventName === 'Withdrawn') {
          record.publisher = event.args.publisher;
          record.amount = event.args.amount.toString();
        } else if (event.eventName === 'PromotionAdded') {
          record.promotionId = event.args.promotionId;
          record.creative = event.args.creative;
        } else if (event.eventName === 'PromotionUpdated') {
          record.index = event.args.index.toString();
          record.active = event.args.active;
        } else if (event.eventName === 'CampaignPaused') {
          record.by = event.args.by;
        } else if (event.eventName === 'CampaignUnpaused') {
          record.by = event.args.by;
        } else if (event.eventName === 'BudgetAdded') {
          record.from = event.args.from;
          record.amount = event.args.amount.toString();
        }

        eventRecords.push(record);
      }
    }

    console.log(`[interpreter:campaign] Processed ${eventRecords.length} events for ${address}`);
    return eventRecords;
  }
}
