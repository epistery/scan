import express from 'express';

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
   * Search — knowledge first, chain second
   */
  async search(query, limit = 20) {
    const q = query.trim();
    const results = {
      query: q,
      results: [],
      meta: { total: 0, source: 'signed-web' }
    };

    // Blockchain address — direct chain lookup
    if (/^0x[a-f0-9]{40}$/i.test(q)) {
      const entity = await this.db.collection('entities').findOne({
        address: new RegExp(`^${q}$`, 'i')
      });
      if (entity) {
        results.results.push(this.formatResult(entity));
        results.meta.total = 1;
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
        return results;
      }
    } catch (err) {
      // Text index may not exist yet on empty DB — fall through to regex
      console.warn('[search] Text search failed, falling back to regex:', err.message);
    }

    // Fallback — regex search across key fields
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
    return results;
  }

  /**
   * Format an entity into a search result
   */
  formatResult(entity) {
    const manifest = entity.metadata?.manifest;
    const org = manifest?.organization || {};
    const sig = entity.metadata?.verification || entity.metadata?.signature || {};
    const isDiscovery = entity.type === 'AIDiscovery';

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

      // Trust
      signature: {
        signed: sig.signed || sig.hashValid || false,
        verified: (sig.hashValid && sig.digitalNameMatch) || false,
        digitalName: sig.digitalName || manifest?._signature?.digitalName || org.digitalName || null,
        method: sig.method || manifest?._signature?.method || null
      },

      // Metadata
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
    const [domainCount, signedCount, verifiedCount, totalEntities, conceptCount] = await Promise.all([
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
      ]).toArray().then(r => r[0]?.total || 0)
    ]);

    return {
      domains: domainCount,
      signed: signedCount,
      verified: verifiedCount,
      totalEntities,
      concepts: conceptCount,
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
}
