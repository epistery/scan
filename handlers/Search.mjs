import express from 'express';
import { ethers } from 'ethers';
import { summarizeSignals, trustLabel } from '../lib/Posture.mjs';

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
const EPISTERY_ABI = [
  'function owner() view returns (address)',
  'function domain() view returns (string)',
  'function VERSION() view returns (string)'
];

const KNOWN_TOKENS = {
  ethereum: [
    // Stablecoins
    { symbol: 'USDC',  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    { symbol: 'USDT',  address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    { symbol: 'DAI',   address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },
    { symbol: 'FRAX',  address: '0x853d955aCEf822Db058eb8505911ED77F175b99e', decimals: 18 },
    { symbol: 'USDe',  address: '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3', decimals: 18 },
    // Wrapped assets
    { symbol: 'WETH',  address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
    { symbol: 'WBTC',  address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8 },
    { symbol: 'stETH', address: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', decimals: 18 },
    { symbol: 'rETH',  address: '0xae78736Cd615f374D3085123A210448E74Fc6393', decimals: 18 },
    { symbol: 'cbETH', address: '0xBe9895146f7AF43049ca1c1AE358B0541Ea49704', decimals: 18 },
    // DeFi governance
    { symbol: 'UNI',   address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', decimals: 18 },
    { symbol: 'LINK',  address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', decimals: 18 },
    { symbol: 'AAVE',  address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', decimals: 18 },
    { symbol: 'MKR',   address: '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2', decimals: 18 },
    { symbol: 'SNX',   address: '0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F', decimals: 18 },
    { symbol: 'COMP',  address: '0xc00e94Cb662C3520282E6f5717214004A7f26888', decimals: 18 },
    { symbol: 'CRV',   address: '0xD533a949740bb3306d119CC777fa900bA034cd52', decimals: 18 },
    { symbol: 'LDO',   address: '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32', decimals: 18 },
    { symbol: 'BAL',   address: '0xba100000625a3754423978a60c9317c58a424e3D', decimals: 18 },
    { symbol: 'SUSHI', address: '0x6B3595068778DD592e39A122f4f5a5cF09C90fE2', decimals: 18 },
    { symbol: '1INCH', address: '0x111111111117dC0aa78b770fA6A738034120C302', decimals: 18 },
    // L2 & infra tokens
    { symbol: 'MATIC', address: '0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0', decimals: 18 },
    { symbol: 'ARB',   address: '0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1', decimals: 18 },
    { symbol: 'GRT',   address: '0xc944E90C64B2c07662A292be6244BDf05Cda44a7', decimals: 18 },
    { symbol: 'ENS',   address: '0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72', decimals: 18 },
    { symbol: 'RPL',   address: '0xD33526068D116cE69F19A9ee46F0bd304F21A51f', decimals: 18 },
    // Meme / high-volume
    { symbol: 'SHIB',  address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', decimals: 18 },
    { symbol: 'PEPE',  address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', decimals: 18 },
    { symbol: 'APE',   address: '0x4d224452801ACEd8B2F0aebE155379bb5D594381', decimals: 18 },
  ],
  polygon: [
    // Stablecoins
    { symbol: 'USDC',   address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
    { symbol: 'USDC.e', address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', decimals: 6 },
    { symbol: 'USDT',   address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
    { symbol: 'DAI',    address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', decimals: 18 },
    { symbol: 'FRAX',   address: '0x45c32fA6DF82ead1e2EF74d17b76547EDdFaFF89', decimals: 18 },
    { symbol: 'miMATIC',address: '0xa3Fa99A148fA48D14Ed51d610c367C61876997F1', decimals: 18 },
    // Wrapped assets
    { symbol: 'WMATIC', address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', decimals: 18 },
    { symbol: 'WETH',   address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', decimals: 18 },
    { symbol: 'WBTC',   address: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', decimals: 8 },
    // DeFi governance
    { symbol: 'UNI',    address: '0xb33EaAd8d922B1083446DC23f610c2567fB5180f', decimals: 18 },
    { symbol: 'LINK',   address: '0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39', decimals: 18 },
    { symbol: 'AAVE',   address: '0xD6DF932A45C0f255f85145f286eA0b292B21C90B', decimals: 18 },
    { symbol: 'CRV',    address: '0x172370d5Cd63279eFa6d502DAB29171933a610AF', decimals: 18 },
    { symbol: 'BAL',    address: '0x9a71012B13CA4d3D0Cdc72A177DF3ef03b0E76A3', decimals: 18 },
    { symbol: 'SUSHI',  address: '0x0b3F868E0BE5597D5DB7fEB59E1CADBb0fdDa50a', decimals: 18 },
    { symbol: 'QUICK',  address: '0xB5C064F955D8e7F38fE0460C556a72987494eE17', decimals: 18 },
    { symbol: 'COMP',   address: '0x8505b9d2254A7Ae468c0E9dd10Ccea3A837aef5c', decimals: 18 },
    { symbol: 'SNX',    address: '0x50B728D8D964fd00C2d0AAD81718b71311feA968', decimals: 18 },
    { symbol: 'MKR',    address: '0x6f7C932e7684666C9fd1d44527765433e01fF61d', decimals: 18 },
    { symbol: '1INCH',  address: '0x9c2C5fd7b07E95EE044DDeba0E97a665F142394f', decimals: 18 },
    // Metaverse / gaming
    { symbol: 'SAND',   address: '0xBbba073C31bF03b8ACf7c28EF0738DeCF3695683', decimals: 18 },
    { symbol: 'MANA',   address: '0xA1c57f48F0Deb89f569dFbE6E2B7f46D33606fD4', decimals: 18 },
    { symbol: 'GRT',    address: '0x5fe2B58c013d7601147DcdD68C143A77499f5531', decimals: 18 },
    { symbol: 'GHST',   address: '0x385Eeac5cB85A38A9a07A70c73e0a3271CfB54A7', decimals: 18 },
    { symbol: 'STG',    address: '0x2F6F07CDcf3588944Bf4C42aC74ff24bF56e7590', decimals: 18 },
  ]
};

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

// Reverse lookup: chain → lowercased address → token info
const TOKEN_BY_ADDRESS = {};
for (const [chain, tokens] of Object.entries(KNOWN_TOKENS)) {
  TOKEN_BY_ADDRESS[chain] = {};
  for (const t of tokens) TOKEN_BY_ADDRESS[chain][t.address.toLowerCase()] = t;
}

const NATIVE_CURRENCY = {
  polygon: 'MATIC', ethereum: 'ETH', sepolia: 'ETH',
  'polygon-amoy': 'MATIC', japanopenchain: 'JOC'
};

/**
 * SearchHandler — Knowledge-First Architecture
 *
 * Philosophy: The web is authored, not scraped. Search returns what organizations
 * have published and signed via /.well-known/ai manifests. Blockchain provides
 * the trust substrate — signature verification, identity binding — but is not
 * the primary search surface.
 *
 * For text queries: Full-text search across indexed manifests (org name, concepts, apps)
 * For domains: Direct lookup + on-demand discovery if not yet indexed
 * For addresses: Chain lookup (secondary, for trust verification)
 */
export default class SearchHandler {
  constructor(connector, harness) {
    this.connector = connector;
    this.db = connector.db;
    this.harness = harness || null;
    this.ingestion = null;
  }

  setIngestion(ingestion) {
    this.ingestion = ingestion;
  }

  routes() {
    const router = express.Router();

    /**
     * Knowledge search — the main endpoint
     * GET /api/search?q=blockchain&limit=20
     */
    router.get('/', async (req, res) => {
      try {
        const query = req.query.q;
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);

        if (!query) {
          return res.status(400).json({ error: 'Query parameter "q" is required' });
        }

        const results = await this.search(query, limit);
        res.json(results);
      } catch (error) {
        console.error('[search] Error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    /**
     * Get full details for a specific domain or address
     * GET /api/search/entity/:id
     */
    router.get('/entity/:id', async (req, res) => {
      try {
        const id = req.params.id.toLowerCase();
        const entity = await this.getEntity(id);
        if (!entity) {
          return res.status(404).json({ error: 'Not found' });
        }
        res.json(entity);
      } catch (error) {
        console.error('[search] Error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    /**
     * Index stats — how much of the signed web we've indexed
     * GET /api/search/stats
     */
    router.get('/stats', async (req, res) => {
      try {
        const stats = await this.getStats();
        res.json(stats);
      } catch (error) {
        console.error('[search] Error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    /**
     * Full wallet detail across all chains
     * GET /api/search/address/:address
     */
    router.get('/address/:address', async (req, res) => {
      try {
        const address = req.params.address;
        if (!/^0x[a-f0-9]{40}$/i.test(address)) {
          return res.status(400).json({ error: 'Invalid address format' });
        }
        const chainResults = await this.queryChainForAddress(address);
        res.json({ address, chains: chainResults });
      } catch (error) {
        console.error('[search] Address lookup error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    /**
     * Recent token transfers for a wallet address
     * GET /api/search/address/:address/activity
     */
    router.get('/address/:address/activity', async (req, res) => {
      try {
        const address = req.params.address;
        if (!/^0x[a-f0-9]{40}$/i.test(address)) {
          return res.status(400).json({ error: 'Invalid address format' });
        }
        const transfers = await this.getRecentTransfers(address);
        res.json({ address, transfers });
      } catch (error) {
        console.error('[search] Activity lookup error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    /**
     * Submit a domain for indexing
     * POST /api/search/submit { domain: "example.com" }
     */
    router.post('/submit', async (req, res) => {
      try {
        const domain = (req.body.domain || '').trim().toLowerCase();
        if (!domain || !domain.includes('.')) {
          return res.status(400).json({ error: 'Valid domain required' });
        }

        const result = await this.submitDomain(domain);
        res.json(result);
      } catch (error) {
        console.error('[search] Error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    return router;
  }

  /**
   * Search — knowledge first, chain second, federated across harness children.
   * Queries starting with @service-name delegate to a live MCP service.
   */
  async search(query, limit = 20) {
    const q = query.trim();

    // Explicit MCP delegation: @service-name <query>
    const delegateMatch = q.match(/^@(\S+)\s*(.*)/);
    if (delegateMatch && this.harness) {
      return this._delegateToService(delegateMatch[1], delegateMatch[2].trim(), limit);
    }
    const results = {
      query: q,
      results: [],
      meta: { total: 0, sources: ['signed-web'] }
    };

    // Fire federated query in parallel (non-blocking until we need it)
    const childPromise = this.harness
      ? this.harness.query(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`)
      : Promise.resolve([]);

    // Blockchain address — direct chain lookup + reverse identity search
    if (/^0x[a-f0-9]{40}$/i.test(q)) {
      const addrRegex = new RegExp(`^${q}$`, 'i');
      const entities = await this.db.collection('entities').find({
        $or: [
          { address: addrRegex },
          { 'metadata.owner': addrRegex },
          { 'metadata.host': addrRegex },
          { 'metadata.verification.digitalName': addrRegex },
          { 'metadata.manifest._signature.digitalName': addrRegex },
          { 'metadata.identityLinks.address': addrRegex }
        ]
      }).limit(20).toArray();

      if (entities.length > 0) {
        results.results = entities.map(e => this.formatResult(e));
        results.meta.total = entities.length;
      }

      // Live chain query — runs in parallel across all configured chains
      if (this.ingestion?.connectors) {
        try {
          const chainResults = await this.queryChainForAddress(q);
          for (const cr of chainResults) {
            results.results.push(this.formatWalletResult(q, cr));
          }
          if (chainResults.length > 0) {
            results.meta.total = results.results.length;
            results.meta.sources.push('live-rpc');
            // Background index for future lookups
            this._backgroundIndexAddress(q, chainResults).catch(e =>
              console.warn('[search] Background index failed:', e.message)
            );
          }
        } catch (err) {
          console.warn('[search] Chain query failed:', err.message);
        }
      }

      return results;
    }

    // Domain-like query — direct lookup + trigger discovery if unknown
    if (q.includes('.') && !q.includes(' ')) {
      const domain = q.toLowerCase();
      const entity = await this.db.collection('entities').findOne({
        address: domain, type: 'AIDiscovery'
      });

      if (entity) {
        results.results.push(this.formatResult(entity));
        results.meta.total = 1;
      } else if (this.ingestion?.domainDiscovery) {
        // Not indexed yet — trigger discovery in background
        this.ingestion.domainDiscovery.checkDomain(domain).catch(console.error);
        results.meta.discovering = domain;
        results.meta.message = `Checking ${domain} for /.well-known/ai manifest...`;
      }
      return results;
    }

    // Text search — full-text across indexed manifests
    try {
      const textResults = await this.db.collection('entities')
        .find(
          { $text: { $search: q } },
          { score: { $meta: 'textScore' } }
        )
        .sort({ score: { $meta: 'textScore' } })
        .limit(limit)
        .toArray();

      if (textResults.length > 0) {
        results.results = textResults.map(e => this.formatResult(e));
        results.meta.total = textResults.length;
      }
    } catch (err) {
      // Text index may not exist yet on empty DB — fall through to regex
      console.warn('[search] Text search failed, falling back to regex:', err.message);
    }

    // Fallback — regex search if text search yielded nothing
    if (results.results.length === 0) {
      const searchRegex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const entities = await this.db.collection('entities')
        .find({
          $or: [
            { address: searchRegex },
            { 'metadata.manifest.organization.name': searchRegex },
            { 'metadata.manifest.organization.mission': searchRegex },
            { 'metadata.manifest.coreConcepts.term': searchRegex },
            { 'metadata.manifest.applications.name': searchRegex },
            { 'metadata.manifest.people.name': searchRegex },
            { 'metadata.domain': searchRegex }
          ]
        })
        .sort({ _modified: -1 })
        .limit(limit)
        .toArray();

      results.results = entities.map(e => this.formatResult(e));
      results.meta.total = entities.length;
    }

    // Merge federated results from harness children
    try {
      const childResponses = await childPromise;
      this._mergeChildResults(results, childResponses, limit);
    } catch (err) {
      console.warn('[search] Federated query failed:', err.message);
    }

    return results;
  }

  /**
   * Merge child responses into the main results object
   */
  _mergeChildResults(results, childResponses, limit) {
    if (!childResponses.length) return;

    for (const child of childResponses) {
      const items = child.data?.results || [];
      if (!items.length) continue;

      // Track this source
      if (!results.meta.sources.includes(child.hostname)) {
        results.meta.sources.push(child.hostname);
      }

      for (const item of items) {
        if (results.results.length >= limit) break;
        results.results.push(this._normalizeChildResult(item, child.hostname));
      }
    }

    results.meta.total = results.results.length;
  }

  /**
   * Delegate query to a live MCP service via mcp-registry proxy.
   * 1. Fetch live tools for the service
   * 2. Pick best-matching tool from the query text
   * 3. Call the tool and return results
   */
  async _delegateToService(serviceName, queryText, limit) {
    const MCP_HOST = 'mcp.epistery.io';

    // Get live tool list
    const toolsResp = await this.harness.post(
      MCP_HOST,
      `/api/service/${encodeURIComponent(serviceName)}/tools`,
      {}
    );

    if (!toolsResp || toolsResp.data?.error) {
      return {
        query: `@${serviceName} ${queryText}`,
        results: [],
        meta: {
          total: 0,
          sources: [MCP_HOST],
          error: toolsResp?.data?.error || 'Service unreachable',
          delegation: { service: serviceName, status: 'failed' }
        }
      };
    }

    const tools = toolsResp.data.tools || [];
    if (!tools.length) {
      return {
        query: `@${serviceName} ${queryText}`,
        results: [],
        meta: {
          total: 0,
          sources: [MCP_HOST],
          delegation: { service: serviceName, status: 'no_tools', endpoint_status: toolsResp.data.status }
        }
      };
    }

    // Pick the best-matching tool: keyword match against tool name + description
    const tool = this._pickTool(tools, queryText);

    // Call the tool
    const callResp = await this.harness.post(
      MCP_HOST,
      `/api/service/${encodeURIComponent(serviceName)}/call`,
      { tool: tool.name, arguments: queryText ? { query: queryText } : {} }
    );

    const callData = callResp?.data || {};

    return {
      query: `@${serviceName} ${queryText}`,
      results: callData.result ? [callData.result] : [],
      meta: {
        total: callData.result ? 1 : 0,
        sources: [MCP_HOST],
        delegation: {
          service: serviceName,
          tool: tool.name,
          status: callData.status || 'unknown',
          response_time_ms: callData.response_time_ms,
          available_tools: tools.map(t => t.name),
        }
      }
    };
  }

  /**
   * Pick the best tool from a tools list given query text.
   * Simple keyword scoring: count how many query words appear in tool name + description.
   */
  _pickTool(tools, queryText) {
    if (!queryText || tools.length === 1) return tools[0];

    const words = queryText.toLowerCase().split(/\s+/);
    let best = tools[0];
    let bestScore = -1;

    for (const tool of tools) {
      const haystack = `${tool.name} ${tool.description || ''}`.toLowerCase();
      let score = 0;
      for (const w of words) {
        if (haystack.includes(w)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        best = tool;
      }
    }
    return best;
  }

  /**
   * Normalize a child result (mcp-registry shape) into scan's result format
   */
  _normalizeChildResult(item, hostname) {
    return {
      domain: hostname,
      name: item.title || item.name,
      type: 'MCPService',
      chain: null,

      mission: item.description || null,
      tagline: null,
      sector: item.category || null,

      concepts: [],
      applications: [],
      people: [],
      capabilities: item.tools_count > 0 ? { tools: true } : null,

      signature: { signed: false, verified: false, digitalName: null, method: null },

      mcpService: {
        tools_count: item.tools_count || 0,
        reachable: item.reachable || false,
        detail_url: item.detail_url || null
      },

      source: hostname,
      discoveryMethod: 'registry',
      lastChecked: null
    };
  }

  /**
   * Format an entity into a search result
   */
  formatResult(entity) {
    const manifest = entity.metadata?.manifest;
    const org = manifest?.organization || {};
    const sig = entity.metadata?.verification || entity.metadata?.signature || {};
    const isDiscovery = entity.type === 'AIDiscovery';

    // Trust score: use stored value or derive from old verification fields
    let trustScore = entity.metadata?.trustScore;
    if (trustScore == null) {
      // Fallback for entities that haven't been re-crawled yet
      trustScore = 0;
      if (sig.signed || sig.hashValid) trustScore += 25;    // selfSigned + manifest
      if (sig.hashValid) trustScore += 10;                   // hashValid
      if (sig.digitalNameMatch) trustScore += 20;            // contractExists
    }

    const result = {
      // Identity
      domain: isDiscovery ? entity.address : (entity.metadata?.domain || null),
      name: org.name || entity.address,
      type: entity.type,
      chain: entity.chain,

      // Authored content
      mission: org.mission || org.description || null,
      tagline: org.tagline || null,
      sector: org.sector || null,

      // What's available
      concepts: (manifest?.coreConcepts || []).map(c => c.term || c),
      applications: (manifest?.applications || []).map(a => ({
        name: a.name,
        description: a.description
      })),
      people: (manifest?.people || []).map(p => ({
        name: p.name,
        role: p.role
      })),
      capabilities: manifest?.capabilities || null,

      // Trust — new signal-based scoring
      trustScore,
      trustLabel: trustLabel(trustScore),
      signals: summarizeSignals(entity.metadata?.signals),
      identityLinks: entity.metadata?.identityLinks || [],

      // Trust — backward compat
      signature: {
        signed: sig.signed || sig.hashValid || false,
        verified: (sig.hashValid && sig.digitalNameMatch) || false,
        digitalName: sig.digitalName || manifest?._signature?.digitalName || org.digitalName || null,
        method: sig.method || manifest?._signature?.method || null
      },

      // Metadata
      source: 'signed-web',
      discoveryMethod: entity.metadata?.discoveryMethod || null,
      lastChecked: entity._modified || entity._created
    };

    return result;
  }

  /**
   * Get full entity details
   */
  async getEntity(id) {
    const entity = await this.db.collection('entities').findOne({
      address: new RegExp(`^${id}$`, 'i')
    });
    if (!entity) return null;
    return this.formatResult(entity);
  }

  /**
   * Index statistics
   */
  async getStats() {
    const [domainCount, signedCount, verifiedCount, totalEntities, conceptCount, trustDistribution] = await Promise.all([
      this.db.collection('entities').countDocuments({ type: 'AIDiscovery' }),
      this.db.collection('entities').countDocuments({
        type: 'AIDiscovery',
        $or: [
          { 'metadata.verification.signed': true },
          { 'metadata.verification.hashValid': true }
        ]
      }),
      this.db.collection('entities').countDocuments({
        type: 'AIDiscovery',
        'metadata.verification.digitalNameMatch': true
      }),
      this.db.collection('entities').estimatedDocumentCount(),
      this.db.collection('entities').aggregate([
        { $match: { type: 'AIDiscovery' } },
        { $project: { count: { $size: { $ifNull: ['$metadata.manifest.coreConcepts', []] } } } },
        { $group: { _id: null, total: { $sum: '$count' } } }
      ]).toArray().then(r => r[0]?.total || 0),
      // Trust score distribution across thresholds
      this.db.collection('entities').aggregate([
        { $match: { type: 'AIDiscovery' } },
        { $group: {
          _id: {
            $switch: {
              branches: [
                { case: { $gte: ['$metadata.trustScore', 75] }, then: 'verified' },
                { case: { $gte: ['$metadata.trustScore', 50] }, then: 'trusted' },
                { case: { $gte: ['$metadata.trustScore', 25] }, then: 'claimed' },
                { case: { $gte: ['$metadata.trustScore', 1] },  then: 'discovered' }
              ],
              default: 'open'
            }
          },
          count: { $sum: 1 }
        }}
      ]).toArray().then(rows => {
        const dist = { open: 0, discovered: 0, claimed: 0, trusted: 0, verified: 0 };
        for (const r of rows) dist[r._id] = r.count;
        return dist;
      })
    ]);

    return {
      domains: domainCount,
      signed: signedCount,
      verified: verifiedCount,
      totalEntities,
      concepts: conceptCount,
      trustDistribution,
      crawling: this.ingestion?.domainDiscovery?.isRunning || false
    };
  }

  /**
   * Submit a domain for discovery
   */
  async submitDomain(domain) {
    if (!this.ingestion?.domainDiscovery) {
      return { status: 'error', message: 'Discovery not available' };
    }

    // Check if already indexed
    const existing = await this.db.collection('entities').findOne({
      address: domain, type: 'AIDiscovery'
    });

    if (existing) {
      return {
        status: 'already_indexed',
        domain,
        result: this.formatResult(existing)
      };
    }

    // Trigger discovery
    this.ingestion.domainDiscovery.checkDomain(domain).catch(console.error);
    return {
      status: 'discovering',
      domain,
      message: `Checking ${domain} for /.well-known/ai manifest...`
    };
  }

  /**
   * Query all configured chains for an address.
   * Returns only chains where the address has activity.
   */
  async queryChainForAddress(address) {
    const connectors = this.ingestion?.connectors;
    if (!connectors) return [];

    const results = await Promise.allSettled(
      Object.entries(connectors).map(async ([chain, connector]) => {
        const provider = connector.provider;
        if (!provider) return null;

        const [code, balanceRaw, txCount] = await Promise.all([
          provider.getCode(address).catch(() => '0x'),
          provider.getBalance(address).catch(() => 0n),
          provider.getTransactionCount(address).catch(() => 0)
        ]);

        const balance = BigInt(balanceRaw);
        const isContract = code && code !== '0x';

        // Skip chains with no activity
        if (balance === 0n && txCount === 0 && !isContract) return null;

        const currency = NATIVE_CURRENCY[chain] || 'ETH';
        const balanceFormatted = this._formatBalance(balance.toString(), 18) + ' ' + currency;

        const result = {
          chain,
          balance: balance.toString(),
          balanceFormatted,
          transactionCount: txCount,
          isContract,
          tokens: [],
          contractMeta: null
        };

        // Check ERC20 token balances
        const tokens = KNOWN_TOKENS[chain] || [];
        if (tokens.length > 0) {
          const tokenResults = await Promise.allSettled(
            tokens.map(async (token) => {
              const bal = await connector.readContract(token.address, ERC20_ABI, 'balanceOf', [address]);
              const tokenBal = BigInt(bal || 0);
              if (tokenBal === 0n) return null;
              return {
                symbol: token.symbol,
                address: token.address,
                balance: tokenBal.toString(),
                balanceFormatted: this._formatBalance(tokenBal.toString(), token.decimals) + ' ' + token.symbol
              };
            })
          );
          result.tokens = tokenResults
            .filter(r => r.status === 'fulfilled' && r.value)
            .map(r => r.value);
        }

        // If contract, try reading epistery identity fields
        if (isContract) {
          const meta = {};
          const reads = await Promise.allSettled([
            connector.readContract(address, EPISTERY_ABI, 'owner', []),
            connector.readContract(address, EPISTERY_ABI, 'domain', []),
            connector.readContract(address, EPISTERY_ABI, 'VERSION', [])
          ]);
          if (reads[0].status === 'fulfilled' && reads[0].value) meta.owner = reads[0].value;
          if (reads[1].status === 'fulfilled' && reads[1].value) meta.domain = reads[1].value;
          if (reads[2].status === 'fulfilled' && reads[2].value) meta.version = reads[2].value;
          if (Object.keys(meta).length > 0) result.contractMeta = meta;
        }

        return result;
      })
    );

    return results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);
  }

  /**
   * Fetch recent ERC20 Transfer events for an address across all chains.
   * Single getLogs call per chain (10k block window). No chunking loop.
   */
  async getRecentTransfers(address) {
    const connectors = this.ingestion?.connectors;
    if (!connectors) return [];

    const allTransfers = [];
    const paddedAddr = ethers.zeroPadValue(address.toLowerCase(), 32);

    await Promise.allSettled(
      Object.entries(connectors).map(async ([chain, connector]) => {
        const provider = connector.provider;
        if (!provider) return;

        try {
          const latest = await provider.getBlockNumber();
          const fromBlock = Math.max(0, latest - 10000);

          const [sentLogs, receivedLogs] = await Promise.all([
            provider.getLogs({
              fromBlock, toBlock: latest,
              topics: [TRANSFER_TOPIC, paddedAddr]
            }).catch(e => {
              console.warn(`[search] getLogs sent ${chain}:`, e.code || e.message);
              return [];
            }),
            provider.getLogs({
              fromBlock, toBlock: latest,
              topics: [TRANSFER_TOPIC, null, paddedAddr]
            }).catch(e => {
              console.warn(`[search] getLogs recv ${chain}:`, e.code || e.message);
              return [];
            })
          ]);

          // Merge and deduplicate
          const seen = new Set();
          const logs = [...sentLogs, ...receivedLogs].filter(log => {
            const key = log.transactionHash + '-' + log.index;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });

          for (const log of logs) {
            const from = ethers.getAddress('0x' + log.topics[1].slice(26));
            const to = ethers.getAddress('0x' + log.topics[2].slice(26));
            const value = BigInt(log.data);
            const tokenInfo = TOKEN_BY_ADDRESS[chain]?.[log.address.toLowerCase()];
            const direction = from.toLowerCase() === address.toLowerCase() ? 'sent' : 'received';

            allTransfers.push({
              chain,
              blockNumber: log.blockNumber,
              transactionHash: log.transactionHash,
              from,
              to,
              direction,
              token: tokenInfo?.symbol || log.address.slice(0, 10) + '...',
              tokenAddress: log.address,
              value: value.toString(),
              valueFormatted: tokenInfo
                ? this._formatBalance(value.toString(), tokenInfo.decimals) + ' ' + tokenInfo.symbol
                : value.toString()
            });
          }
        } catch (err) {
          console.warn(`[search] Transfer query failed for ${chain}:`, err.message);
        }
      })
    );

    allTransfers.sort((a, b) => b.blockNumber - a.blockNumber);
    return allTransfers.slice(0, 20);
  }

  /**
   * Format a wallet/contract chain result into the standard result shape
   */
  formatWalletResult(address, chainData) {
    return {
      domain: null,
      name: address,
      type: chainData.isContract ? 'Contract' : 'Wallet',
      chain: chainData.chain,

      mission: null,
      tagline: null,
      sector: null,
      concepts: [],
      applications: [],
      people: [],
      capabilities: null,

      balance: chainData.balance,
      balanceFormatted: chainData.balanceFormatted,
      transactionCount: chainData.transactionCount,
      isContract: chainData.isContract,
      tokens: chainData.tokens,
      contractMeta: chainData.contractMeta,

      trustScore: 0,
      trustLabel: 'open',
      signals: {},
      identityLinks: [],
      signature: { signed: false, verified: false, digitalName: null, method: null },
      source: 'chain',
      discoveryMethod: 'live-rpc',
      lastChecked: new Date()
    };
  }

  /**
   * Upsert address data into entities collection for future lookups
   */
  async _backgroundIndexAddress(address, chainResults) {
    const now = new Date();
    for (const cr of chainResults) {
      await this.db.collection('entities').updateOne(
        { address: address.toLowerCase(), chain: cr.chain },
        {
          $set: {
            type: cr.isContract ? 'Contract' : 'Wallet',
            chain: cr.chain,
            metadata: {
              balance: cr.balance,
              transactionCount: cr.transactionCount,
              isContract: cr.isContract,
              tokens: cr.tokens,
              contractMeta: cr.contractMeta,
              discoveryMethod: 'live-rpc'
            },
            _modified: now
          },
          $setOnInsert: { _created: now }
        },
        { upsert: true }
      );
    }
  }

  _formatBalance(weiStr, decimals = 18) {
    const num = Number(weiStr) / Math.pow(10, decimals);
    if (num === 0) return '0';
    if (num < 0.001 && num > 0) return num.toExponential(2);
    return num.toFixed(4).replace(/\.?0+$/, '');
  }
}
