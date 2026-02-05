import express from 'express';

/**
 * SearchHandler - Chain-First Architecture
 *
 * Philosophy: The blockchain is the source of truth. MongoDB is only an index
 * to help us know where to look (which chain, what type of contract).
 *
 * For addresses: Check chain directly for contract code and state
 * For transactions: Fetch directly from chain by hash
 * For events: Read from chain on-demand, reconstruct state live
 *
 * MongoDB stores:
 * - Search index (address -> chain mapping)
 * - Computed state cache (to avoid re-processing all events)
 */
export default class SearchHandler {
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
     * Search for an address or transaction
     * GET /api/search?q=0x123...&chain=polygon
     */
    router.get('/', async (req, res) => {
      try {
        const query = req.query.q;
        const chainHint = req.query.chain; // Optional: which chain to check first

        if (!query) {
          return res.status(400).json({ error: 'Query parameter "q" is required' });
        }

        const results = await this.search(query, chainHint);
        res.json(results);
      } catch (error) {
        console.error('[search] Error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    /**
     * Get details for a specific address on a specific chain
     * GET /api/search/address/:address?chain=polygon
     */
    router.get('/address/:address', async (req, res) => {
      try {
        const address = req.params.address.toLowerCase();
        const chain = req.query.chain || 'polygon';

        const details = await this.getAddressDetails(address, chain);
        res.json(details);
      } catch (error) {
        console.error('[search] Error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    /**
     * Get transaction details
     * GET /api/search/tx/:hash?chain=polygon
     */
    router.get('/tx/:hash', async (req, res) => {
      try {
        const txHash = req.params.hash;
        const chain = req.query.chain || 'polygon';

        const details = await this.getTransactionDetails(txHash, chain);
        res.json(details);
      } catch (error) {
        console.error('[search] Error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    /**
     * Get events for an address
     * GET /api/search/events/:address?chain=polygon&fromBlock=0&toBlock=latest&limit=50
     */
    router.get('/events/:address', async (req, res) => {
      try {
        const address = req.params.address.toLowerCase();
        const chain = req.query.chain || 'polygon';
        const fromBlock = req.query.fromBlock ? parseInt(req.query.fromBlock) : undefined;
        const toBlock = req.query.toBlock || 'latest';
        const limit = req.query.limit ? parseInt(req.query.limit) : 50;

        const events = await this.getAddressEvents(address, chain, fromBlock, toBlock, limit);
        res.json({ address, chain, events });
      } catch (error) {
        console.error('[search] Error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    return router;
  }

  /**
   * Search - chain-first approach
   */
  async search(query, chainHint) {
    const results = {
      query,
      found: false,
      type: null,
      chain: null,
      data: null
    };

    const q = query.toLowerCase().trim();

    // Address search (0x + 40 hex chars)
    if (/^0x[a-f0-9]{40}$/i.test(q)) {
      // Check index for known chain
      const addressRegex = new RegExp(`^${q}$`, 'i');
      const knownEntity = await this.db.collection('entities').findOne({ address: addressRegex });

      // Determine which chains to check
      const chainsToCheck = chainHint ? [chainHint] :
                           knownEntity ? [knownEntity.chain] :
                           Object.keys(this.ingestion?.connectors || {});

      // Check each chain until we find the contract
      for (const chain of chainsToCheck) {
        const connector = this.ingestion?.connectors[chain];
        if (!connector) continue;

        try {
          const code = await connector.provider.getCode(q);

          if (code && code !== '0x') {
            // Found a contract!
            results.found = true;
            results.type = 'contract';
            results.chain = chain;
            results.data = await this.getAddressDetails(q, chain);

            // Update index in background
            this.updateIndex(q, chain, 'contract').catch(console.error);

            break;
          } else {
            // Check if it's a wallet with transactions
            const balance = await connector.provider.getBalance(q);
            const txCount = await connector.provider.getTransactionCount(q);

            if (txCount > 0 || balance > 0n) {
              results.found = true;
              results.type = 'wallet';
              results.chain = chain;
              results.data = {
                address: q,
                chain,
                balance: balance.toString(),
                transactionCount: txCount,
                isContract: false
              };

              // Update index in background
              this.updateIndex(q, chain, 'wallet').catch(console.error);

              break;
            }
          }
        } catch (error) {
          console.error(`[search] Error checking ${chain}:`, error.message);
        }
      }

      if (!results.found) {
        results.suggestion = {
          message: 'Address not found on any configured chains',
          chains: chainsToCheck
        };
      }
    }
    // Transaction hash search (0x + 64 hex chars)
    else if (/^0x[a-f0-9]{64}$/i.test(q)) {
      const chainsToCheck = chainHint ? [chainHint] :
                           Object.keys(this.ingestion?.connectors || {});

      for (const chain of chainsToCheck) {
        const connector = this.ingestion?.connectors[chain];
        if (!connector) continue;

        try {
          const tx = await connector.getTransaction(q);
          if (tx) {
            results.found = true;
            results.type = 'transaction';
            results.chain = chain;
            results.data = await this.getTransactionDetails(q, chain);
            break;
          }
        } catch (error) {
          console.error(`[search] Error checking ${chain}:`, error.message);
        }
      }

      if (!results.found) {
        results.suggestion = {
          message: 'Transaction not found on any configured chains'
        };
      }
    }
    // Text search - use MongoDB index
    else {
      const entities = await this.db.collection('entities')
        .find({
          $or: [
            { 'metadata.domain': new RegExp(q, 'i') },
            { 'metadata.owner': new RegExp(q, 'i') }
          ]
        })
        .limit(20)
        .toArray();

      if (entities.length > 0) {
        results.found = true;
        results.type = 'search';
        results.data = entities;
      }
    }

    return results;
  }

  /**
   * Get address details from chain
   */
  async getAddressDetails(address, chain) {
    const connector = this.ingestion?.connectors[chain];
    if (!connector) throw new Error(`Chain ${chain} not configured`);

    const code = await connector.provider.getCode(address);
    const isContract = code && code !== '0x';

    if (!isContract) {
      // It's a wallet
      const balance = await connector.provider.getBalance(address);
      const txCount = await connector.provider.getTransactionCount(address);

      return {
        address,
        chain,
        type: 'wallet',
        balance: balance.toString(),
        transactionCount: txCount,
        isContract: false
      };
    }

    // It's a contract - try to read epistery base attributes
    const details = {
      address,
      chain,
      type: 'contract',
      isContract: true,
      metadata: {}
    };

    // Try standard epistery contract calls
    const abi = [
      'function owner() view returns (address)',
      'function sponsor() view returns (address)',
      'function domain() view returns (string)',
      'function VERSION() view returns (string)'
    ];

    const contract = connector.getContract(address, abi);

    try { details.metadata.owner = await contract.owner(); } catch (e) {}
    try { details.metadata.sponsor = await contract.sponsor(); } catch (e) {}
    try { details.metadata.domain = await contract.domain(); } catch (e) {}
    try { details.metadata.version = await contract.VERSION(); } catch (e) {}

    return details;
  }

  /**
   * Get transaction details from chain
   */
  async getTransactionDetails(hash, chain) {
    const connector = this.ingestion?.connectors[chain];
    if (!connector) throw new Error(`Chain ${chain} not configured`);

    return await connector.getTransactionDetails(hash);
  }

  /**
   * Get events for an address - hybrid approach
   * 1. Check MongoDB cache for known event range
   * 2. If cached, return from cache
   * 3. If not cached or range specified, fetch from chain
   */
  async getAddressEvents(address, chain, fromBlock, toBlock, limit) {
    const addressRegex = new RegExp(`^${address}$`, 'i');

    // Check cache for block range hint only (don't return cached events due to duplication issues)
    const cachedEvents = await this.db.collection('events')
      .find({ entityId: addressRegex })
      .sort({ blockNumber: 1 })
      .limit(1)
      .toArray();

    // Check entity for creation block
    const entity = await this.db.collection('entities').findOne({ address: addressRegex });

    // Otherwise fetch from chain
    const connector = this.ingestion?.connectors[chain];
    if (!connector) throw new Error(`Chain ${chain} not configured`);

    const currentBlock = await connector.getCurrentBlock();

    // Determine block range
    let from, to;

    if (fromBlock !== undefined) {
      from = fromBlock;
    } else if (cachedEvents.length > 0) {
      // Start from oldest cached event
      const oldestEvent = cachedEvents[cachedEvents.length - 1];
      from = oldestEvent.blockNumber || 0;
    } else if (entity?._created) {
      // Entity exists, search from a reasonable time before creation (500k blocks)
      from = Math.max(0, currentBlock - 500000);
    } else {
      // No cache, search recent blocks (last 200000)
      from = Math.max(0, currentBlock - 200000);
    }

    to = toBlock === 'latest' ? currentBlock : parseInt(toBlock);

    console.log(`[search] Fetching events for ${address} from block ${from} to ${to}`);

    // Get all logs for this address
    const logs = await connector.provider.getLogs({
      address,
      fromBlock: from,
      toBlock: to
    });

    // Parse logs into events using combined ABI for all epistery contract types
    const abi = [
      // Agent events
      'event ACLModified(address indexed owner, string listName, address indexed addr, string action, uint256 timestamp)',
      'event AttributeSet(address indexed owner, string key, bool isPrivate, uint256 timestamp)',
      'event AttributeDeleted(address indexed owner, string key, bool isPrivate, uint256 timestamp)',
      'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner, uint256 timestamp)',
      // OpenZeppelin standard events
      'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
      'event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)',
      'event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)',
      // CampaignWallet v2 events
      'event BatchSubmitted(address indexed publisher, string ipfsCID, uint256 payout, bytes32 lastHash)',
      'event Withdrawn(address indexed publisher, uint256 amount)',
      'event PromotionAdded(string promotionId, string creative)',
      'event PromotionUpdated(uint256 indexed index, bool active)',
      'event CampaignPaused(address indexed by)',
      'event CampaignUnpaused(address indexed by)',
      'event BudgetAdded(address indexed from, uint256 amount)'
    ];

    const iface = new (await import('ethers')).ethers.Interface(abi);
    const parsedEvents = [];

    for (const log of logs) {
      try {
        const parsed = iface.parseLog(log);

        // Determine event category
        let eventType = 'unknown';
        const eventName = parsed.name;

        if (['ACLModified', 'AttributeSet', 'AttributeDeleted'].includes(eventName)) {
          eventType = `agent.${eventName}`;
        } else if (eventName === 'OwnershipTransferred') {
          // Detect if this is Agent or OpenZeppelin version by checking arg names
          if (parsed.fragment.inputs.find(i => i.name === 'timestamp')) {
            eventType = 'agent.OwnershipTransferred';
          } else {
            eventType = 'system.OwnershipTransferred';
          }
        } else if (['RoleGranted', 'RoleRevoked'].includes(eventName)) {
          eventType = `system.${eventName}`;
        } else if (['BatchSubmitted', 'Withdrawn', 'PromotionAdded', 'PromotionUpdated',
                    'CampaignPaused', 'CampaignUnpaused', 'BudgetAdded'].includes(eventName)) {
          eventType = `campaign.${eventName}`;
        }

        parsedEvents.push({
          type: eventType,
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
        // Not a recognized event, include raw log
        parsedEvents.push({
          type: 'unknown',
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
          address: log.address,
          topics: log.topics,
          data: log.data
        });
      }
    }

    // Limit results
    return parsedEvents.slice(0, limit);
  }

  /**
   * Update search index in MongoDB (background)
   */
  async updateIndex(address, chain, type) {
    try {
      await this.db.collection('entities').updateOne(
        { address: new RegExp(`^${address}$`, 'i') },
        {
          $set: {
            address,
            chain,
            type,
            _modified: new Date()
          },
          $setOnInsert: {
            _created: new Date()
          }
        },
        { upsert: true }
      );
    } catch (error) {
      console.error('[search] Failed to update index:', error.message);
    }
  }
}
