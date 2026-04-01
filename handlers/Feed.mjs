import express from 'express';

/**
 * FeedHandler
 *
 * Accepts a list of followed addresses from the client and returns
 * recent activity. The server is stateless — the follow list lives
 * in the client's localStorage.
 *
 * Activity sources (in priority order):
 * 1. Contract activity() method: the contract defines its own events
 *    (future — DomainAgent will delegate to an agent like message-board)
 * 2. Interpreter: use the registered interpreter's ABI for known entity types
 * 3. Domain feed: fetch /.well-known/ai/feed if the manifest declares it
 * 4. Cached events: fall back to MongoDB events collection
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

        // Look up all entities
        const patterns = addresses.map(a => new RegExp('^' + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'));
        const entities = await this.db.collection('entities')
          .find({ address: { $in: patterns } })
          .toArray();

        // Build entity lookup
        const entityMap = {};
        entities.forEach(e => { entityMap[e.address.toLowerCase()] = e; });

        // Fetch activity for each address in parallel
        const activityPromises = addresses.map(addr => this.getActivity(addr, entityMap[addr.toLowerCase()]));
        const activityResults = await Promise.allSettled(activityPromises);

        let allEvents = [];
        for (const result of activityResults) {
          if (result.status === 'fulfilled' && result.value) {
            allEvents.push(...result.value);
          }
        }

        // Deduplicate by transactionHash + type (chain events can overlap with cached)
        const seen = new Set();
        allEvents = allEvents.filter(e => {
          const key = `${e.transactionHash || e._id || e._feedId || ''}:${e.type || ''}:${e.blockNumber || e.timestamp || ''}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        // Sort newest first
        allEvents.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

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

    /**
     * POST /api/feed/post
     * Body: { target: "geist.social", text: "Hello world" }
     * Auth: req.episteryClient.address (from epistery middleware cookie)
     */
    router.post('/post', async (req, res) => {
      try {
        const { target, text } = req.body;

        if (!target || typeof target !== 'string') {
          return res.status(400).json({ error: 'target is required' });
        }
        if (!text || typeof text !== 'string' || !text.trim()) {
          return res.status(400).json({ error: 'text is required and must be non-empty' });
        }
        if (text.length > 2000) {
          return res.status(400).json({ error: 'text must be 2000 characters or fewer' });
        }

        const sender = req.episteryClient?.address || 'anonymous';

        const event = {
          source: 'message',
          entityId: target,
          type: 'message.post',
          sender,
          data: { text: text.trim() },
          timestamp: Date.now()
        };

        await this.db.collection('events').insertOne(event);
        console.log(`[feed] Message posted by ${sender} to ${target}`);

        // Async: forward to target domain's message-board if available
        this.forwardToMessageBoard(target, sender, text.trim()).catch(err => {
          console.error(`[feed] Forward to ${target} message-board failed:`, err.message);
        });

        res.json({ ok: true, event });
      } catch (error) {
        console.error('[feed] Post error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    return router;
  }

  /**
   * Forward a message to a target domain's message-board agent (best effort).
   * Checks if the entity has a message-board agent in its manifest.
   */
  async forwardToMessageBoard(target, sender, text) {
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const entity = await this.db.collection('entities').findOne({
      address: new RegExp(`^${escaped}$`, 'i')
    });

    const agents = entity?.metadata?.manifest?.agents;
    if (!agents) return;

    // Check if message-board agent is listed
    const hasMessageBoard = Array.isArray(agents)
      ? agents.some(a => typeof a === 'string' ? a.includes('message-board') : a.name?.includes('message-board'))
      : (typeof agents === 'object' && Object.keys(agents).some(k => k.includes('message-board')));

    if (!hasMessageBoard) {
      console.log(`[feed] ${target} has no message-board agent, skipping forward`);
      return;
    }

    const url = `https://${target}/agent/epistery/message-board/api/posts`;
    console.log(`[feed] Forwarding message to ${url}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender, text }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      console.log(`[feed] Forward to ${target}: ${response.status}`);
    } catch (e) {
      clearTimeout(timeout);
      throw e;
    }
  }

  /**
   * Get activity for a single address. Tries each source in priority order.
   */
  async getActivity(address, entity) {
    const isChainAddress = /^0x[a-f0-9]{40}$/i.test(address);

    if (isChainAddress) {
      return await this.getChainActivity(address, entity);
    } else {
      return await this.getDomainActivity(address, entity);
    }
  }

  /**
   * Get activity for a blockchain address.
   * 1. Try calling contract activity() — the contract defines its events
   * 2. Use interpreter if entity type is known (or identify the contract)
   * 3. Fall back to cached events in MongoDB
   */
  async getChainActivity(address, entity) {
    if (!this.ingestion) return this.getCachedEvents(address);

    const chain = entity?.chain || Object.keys(this.ingestion.connectors)[0];
    const connector = this.ingestion.connectors[chain];
    if (!connector) return this.getCachedEvents(address);

    // 1. Try contract activity() method
    //    Future: DomainAgent will delegate to a chosen agent (e.g. message-board)
    try {
      const activityEvents = await this.callContractActivity(address, chain, connector);
      if (activityEvents && activityEvents.length > 0) {
        return activityEvents;
      }
    } catch (e) {
      // Contract doesn't expose activity(), continue
    }

    // 2. Determine entity type — from index or by probing the contract
    let entityType = entity?.type;
    if (!entityType || !this.ingestion.registry?.has(entityType)) {
      console.log(`[feed] Identifying contract ${address} (current type: ${entityType || 'none'})`);
      entityType = await this.identifyContract(address, chain, connector);
    }

    if (entityType && this.ingestion.registry?.has(entityType)) {
      try {
        const events = await this.fetchViaInterpreter(address, chain, entityType);
        if (events && events.length > 0) return events;
      } catch (e) {
        console.error(`[feed] Interpreter failed for ${address}:`, e.message);
      }
    }

    // 3. Fall back to cached events
    return this.getCachedEvents(address);
  }

  /**
   * Identify a contract by probing its methods.
   * DomainAgent has domain() and VERSION(). CampaignWallet has different signatures.
   * Each probe has a 5-second timeout to avoid hanging.
   */
  async identifyContract(address, chain, connector) {
    const withTimeout = (promise, ms = 5000) =>
      Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

    // Check if there's code at this address
    try {
      const code = await withTimeout(connector.provider.getCode(address));
      if (!code || code === '0x') return null; // EOA, not a contract
    } catch (e) {
      return null;
    }

    // Probe for DomainAgent — has domain() and VERSION()
    try {
      const probeAbi = [
        'function domain() view returns (string)',
        'function VERSION() view returns (string)'
      ];
      const contract = connector.getContract(address, probeAbi);
      const domain = await withTimeout(contract.domain());
      if (domain && domain.length > 0) {
        console.log(`[feed] Identified ${address} as Agent (domain: ${domain})`);
        this.indexEntity(address, chain, 'Agent', { domain }).catch(console.error);
        return 'Agent';
      }
    } catch (e) {
      // Not a DomainAgent
    }

    // Probe for CampaignWallet — has advertiser()
    try {
      const probeAbi = [
        'function advertiser() view returns (address)'
      ];
      const contract = connector.getContract(address, probeAbi);
      await withTimeout(contract.advertiser());
      console.log(`[feed] Identified ${address} as CampaignWallet`);
      this.indexEntity(address, chain, 'CampaignWallet', {}).catch(console.error);
      return 'CampaignWallet';
    } catch (e) {
      // Not a CampaignWallet
    }

    // Probe for IdentityContract — has threshold()
    try {
      const probeAbi = [
        'function threshold() view returns (uint256)'
      ];
      const contract = connector.getContract(address, probeAbi);
      await withTimeout(contract.threshold());
      console.log(`[feed] Identified ${address} as IdentityContract`);
      this.indexEntity(address, chain, 'IdentityContract', {}).catch(console.error);
      return 'IdentityContract';
    } catch (e) {
      // Not an IdentityContract
    }

    return null;
  }

  /**
   * Save identified entity to MongoDB so we don't probe again next time.
   */
  async indexEntity(address, chain, type, metadata) {
    const addressRegex = new RegExp(`^${address}$`, 'i');
    await this.db.collection('entities').updateOne(
      { address: addressRegex },
      {
        $set: { address: address.toLowerCase(), chain, type, metadata, _modified: new Date() },
        $setOnInsert: { _created: new Date() }
      },
      { upsert: true }
    );
  }

  /**
   * Call a contract's activity() method. The contract itself reports
   * what it considers noteworthy. Today no contracts implement this.
   * When DomainAgent delegates to message-board, this is where it lands.
   */
  async callContractActivity(address, chain, connector) {
    const abi = [
      'function activity() view returns (tuple(string eventType, uint256 timestamp, string data)[])',
      'function activity(uint256 limit) view returns (tuple(string eventType, uint256 timestamp, string data)[])'
    ];

    const contract = connector.getContract(address, abi);
    const withTimeout = (promise, ms = 3000) =>
      Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

    let rawActivity;
    try {
      rawActivity = await withTimeout(contract.activity(50));
    } catch (e) {
      rawActivity = await withTimeout(contract.activity());
    }

    if (!rawActivity || rawActivity.length === 0) return null;

    return rawActivity.map(item => ({
      type: item.eventType,
      entityId: address.toLowerCase(),
      timestamp: Number(item.timestamp) * 1000,
      data: item.data,
      source: 'contract'
    }));
  }

  /**
   * Get events for a blockchain address using the interpreter's ABI.
   * For the feed, we use cached events from MongoDB (populated by the
   * ingestion pipeline). Direct chain scanning is too slow for a feed
   * request — Polygon's 1-block chunk size makes large scans impractical.
   *
   * If no cached events exist, trigger an async ingestion sync so
   * events will be available on the next feed load.
   */
  async fetchViaInterpreter(address, chain, entityType) {
    const interpreter = this.ingestion.registry.get(entityType);
    if (!interpreter) return null;

    // Use cached events from MongoDB
    const events = await this.getCachedEvents(address);

    if (events.length > 0) {
      return events;
    }

    // No cached events — ensure this address is monitored so
    // the ingestion pipeline picks it up for next time
    const monitor = await this.db.collection('monitors').findOne({
      address: address.toLowerCase(), chain
    });
    if (!monitor) {
      console.log(`[feed] Adding monitor for ${entityType} ${address} on ${chain}`);
      this.ingestion.addMonitor(address, chain, entityType).catch(err => {
        console.error(`[feed] Failed to add monitor for ${address}:`, err.message);
      });
    }

    return [];
  }

  /**
   * Get activity for a domain.
   * 1. If manifest declares a feed capability, fetch from domain's feed endpoint
   * 2. Resolve to blockchain contract via metadata.domain and get chain events
   * 3. Fall back to cached discovery events in MongoDB
   */
  async getDomainActivity(address, entity) {
    console.log(`[feed] getDomainActivity(${address}) entity=${entity?.type || 'none'}`);

    // 1. Check if manifest declares a feed capability (respect available: false)
    const manifest = entity?.metadata?.manifest;
    const feedCap = manifest?.capabilities?.feed;
    const hasFeed = feedCap && (feedCap === true || feedCap.available === true);
    if (hasFeed) {
      try {
        const feedData = await this.fetchDomainFeed(address, feedCap);
        if (feedData && feedData.length > 0) return feedData;
      } catch (e) {
        console.error(`[feed] Domain feed fetch failed for ${address}:`, e.message);
      }
    }

    // 2. Resolve domain to its blockchain contract (Agent with metadata.domain)
    if (this.ingestion) {
      try {
        const domainRegex = new RegExp(`^${address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
        const agent = await this.db.collection('entities').findOne({
          type: 'Agent',
          'metadata.domain': domainRegex
        });

        if (agent) {
          console.log(`[feed] Resolved domain ${address} to contract ${agent.address} on ${agent.chain}`);
          const events = await this.getChainActivity(agent.address, agent);
          if (events && events.length > 0) {
            // Tag events with the domain name so the UI can label them
            return events.map(e => ({ ...e, domainLabel: address }));
          }
        }
      } catch (e) {
        console.error(`[feed] Domain-to-contract resolution failed for ${address}:`, e.message);
      }
    }

    // 3. Fall back to cached events
    return this.getCachedEvents(address);
  }

  /**
   * Fetch activity from a domain's declared feed endpoint.
   * The domain defines what its events are.
   */
  async fetchDomainFeed(domain, feedCapability) {
    const url = typeof feedCapability === 'object' && feedCapability.url
      ? feedCapability.url
      : `https://${domain}/.well-known/ai/feed`;

    const fullUrl = url.startsWith('http') ? url : `https://${domain}${url}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(fullUrl, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' }
      });
      clearTimeout(timeout);

      if (!response.ok) return null;

      const data = await response.json();
      const items = Array.isArray(data) ? data : (data.items || data.events || data.feed || []);

      return items.map(item => ({
        type: item.type || item.eventType || 'activity',
        entityId: domain,
        timestamp: new Date(item.timestamp || item.published || item.date || Date.now()).getTime(),
        title: item.title,
        data: item.data || item.description || item.summary,
        source: 'domain-feed',
        url: item.url,
        _feedId: item.id || item.url || item.title
      }));
    } catch (e) {
      clearTimeout(timeout);
      throw e;
    }
  }

  /**
   * Fall back to MongoDB cached events for an address.
   */
  async getCachedEvents(address) {
    const escaped = address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const addressRegex = new RegExp(`^${escaped}$`, 'i');
    const events = await this.db.collection('events')
      .find({ entityId: addressRegex })
      .sort({ timestamp: -1 })
      .limit(50)
      .toArray();
    console.log(`[feed] getCachedEvents(${address}): ${events.length} events`);
    return events;
  }
}
