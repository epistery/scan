import express from 'express';

/**
 * FeedHandler
 *
 * Accepts a list of followed addresses from the client and returns
 * matching entities and recent events. The server is stateless —
 * the follow list lives in the client's localStorage.
 *
 * For blockchain addresses (0x...), fetches events from chain RPC directly
 * (same as the search handler). For domains, queries MongoDB.
 */
export default class FeedHandler {
  constructor(connector) {
    this.connector = connector;
    this.db = connector.db;
    this.ingestion = null;
  }

  setIngestion(ingestion) {
    this.ingestion = ingestion;
  }

  routes() {
    const router = express.Router();

    /**
     * POST /api/feed
     * Body: { addresses: ["0x123...", "example.com"], limit: 50, skip: 0 }
     * Returns: { entities: [...], events: [...], pagination: {...} }
     */
    router.post('/', async (req, res) => {
      try {
        let { addresses, limit = 50, skip = 0 } = req.body;

        if (!Array.isArray(addresses) || addresses.length === 0) {
          return res.status(400).json({ error: 'addresses must be a non-empty array' });
        }

        if (addresses.length > 50) {
          addresses = addresses.slice(0, 50);
        }

        limit = Math.min(parseInt(limit) || 50, 200);
        skip = parseInt(skip) || 0;

        // Separate blockchain addresses from domains
        const chainAddresses = addresses.filter(a => /^0x[a-f0-9]{40}$/i.test(a));
        const domainAddresses = addresses.filter(a => !/^0x[a-f0-9]{40}$/i.test(a));

        // Fetch entities from MongoDB for all addresses
        const patterns = addresses.map(a => new RegExp('^' + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'));
        const entities = await this.db.collection('entities')
          .find({ address: { $in: patterns } })
          .toArray();

        let allEvents = [];

        // For blockchain addresses, fetch events from chain RPC
        if (chainAddresses.length > 0 && this.ingestion) {
          const chainPromises = chainAddresses.map(addr => this.fetchChainEvents(addr, limit));
          const chainResults = await Promise.allSettled(chainPromises);
          for (const result of chainResults) {
            if (result.status === 'fulfilled' && result.value) {
              allEvents.push(...result.value);
            }
          }
        }

        // For domains, query MongoDB events
        if (domainAddresses.length > 0) {
          const domainPatterns = domainAddresses.map(a => a.toLowerCase());
          const domainEvents = await this.db.collection('events')
            .find({ entityId: { $in: domainPatterns } })
            .sort({ timestamp: -1 })
            .limit(limit)
            .toArray();
          allEvents.push(...domainEvents);
        }

        // Also check MongoDB for any cached events for chain addresses
        if (chainAddresses.length > 0) {
          const chainIds = chainAddresses.map(a => a.toLowerCase());
          const cachedEvents = await this.db.collection('events')
            .find({ entityId: { $in: chainIds } })
            .sort({ timestamp: -1 })
            .limit(limit)
            .toArray();
          allEvents.push(...cachedEvents);
        }

        // Deduplicate by transactionHash + type
        const seen = new Set();
        allEvents = allEvents.filter(e => {
          const key = `${e.transactionHash || ''}:${e.type || ''}:${e.blockNumber || ''}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        // Sort by timestamp descending (newest first)
        allEvents.sort((a, b) => {
          const tsA = a.timestamp || 0;
          const tsB = b.timestamp || 0;
          return tsB - tsA;
        });

        // Apply pagination
        const total = allEvents.length;
        const paged = allEvents.slice(skip, skip + limit);

        res.json({
          entities,
          events: paged,
          pagination: { total, limit, skip }
        });
      } catch (error) {
        console.error('[feed] Error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    return router;
  }

  /**
   * Fetch events for a blockchain address directly from chain RPC.
   * Same approach as SearchHandler.getAddressEvents.
   */
  async fetchChainEvents(address, limit) {
    // Determine chain from entity index or try all connectors
    const addressRegex = new RegExp(`^${address}$`, 'i');
    const entity = await this.db.collection('entities').findOne({ address: addressRegex });
    const chains = entity ? [entity.chain] : Object.keys(this.ingestion.connectors);

    for (const chain of chains) {
      const connector = this.ingestion.connectors[chain];
      if (!connector) continue;

      try {
        const currentBlock = await connector.getCurrentBlock();
        // Scan recent blocks (last 200k ~ a few days on polygon)
        const fromBlock = entity?.lastProcessedBlock || Math.max(0, currentBlock - 200000);

        const logs = await connector.provider.getLogs({
          address,
          fromBlock,
          toBlock: currentBlock
        });

        if (logs.length === 0) continue;

        const { ethers } = await import('ethers');
        const abi = [
          'event ACLModified(address indexed owner, string listName, address indexed addr, string action, uint256 timestamp)',
          'event AttributeSet(address indexed owner, string key, bool isPrivate, uint256 timestamp)',
          'event AttributeDeleted(address indexed owner, string key, bool isPrivate, uint256 timestamp)',
          'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner, uint256 timestamp)',
          'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
          'event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)',
          'event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)',
          'event BatchSubmitted(address indexed publisher, string ipfsCID, uint256 payout, bytes32 lastHash)',
          'event Withdrawn(address indexed publisher, uint256 amount)',
          'event PromotionAdded(string promotionId, string creative)',
          'event PromotionUpdated(uint256 indexed index, bool active)',
          'event CampaignPaused(address indexed by)',
          'event CampaignUnpaused(address indexed by)',
          'event BudgetAdded(address indexed from, uint256 amount)'
        ];

        const iface = new ethers.Interface(abi);
        const events = [];

        for (const log of logs) {
          try {
            const parsed = iface.parseLog(log);
            let eventType = 'unknown';
            const name = parsed.name;

            if (['ACLModified', 'AttributeSet', 'AttributeDeleted'].includes(name)) {
              eventType = `agent.${name}`;
            } else if (name === 'OwnershipTransferred') {
              eventType = parsed.fragment.inputs.find(i => i.name === 'timestamp')
                ? 'agent.OwnershipTransferred' : 'system.OwnershipTransferred';
            } else if (['RoleGranted', 'RoleRevoked'].includes(name)) {
              eventType = `system.${name}`;
            } else if (['BatchSubmitted', 'Withdrawn', 'PromotionAdded', 'PromotionUpdated',
                        'CampaignPaused', 'CampaignUnpaused', 'BudgetAdded'].includes(name)) {
              eventType = `campaign.${name}`;
            }

            events.push({
              type: eventType,
              entityId: address.toLowerCase(),
              blockNumber: log.blockNumber,
              transactionHash: log.transactionHash,
              address: log.address,
              ...Object.fromEntries(
                parsed.args.toArray().map((val, idx) => [
                  parsed.fragment.inputs[idx].name,
                  typeof val === 'bigint' ? Number(val) : val
                ])
              )
            });
          } catch (e) {
            events.push({
              type: 'unknown',
              entityId: address.toLowerCase(),
              blockNumber: log.blockNumber,
              transactionHash: log.transactionHash,
              address: log.address,
              topics: log.topics,
              data: log.data
            });
          }
        }

        return events.slice(0, limit);
      } catch (error) {
        console.error(`[feed] Error fetching ${address} on ${chain}:`, error.message);
      }
    }

    return [];
  }
}
