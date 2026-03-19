import express from 'express';

/**
 * DiscoveryHandler
 *
 * API for managing AI discovery domains. Domains that publish /.well-known/ai
 * manifests are indexed alongside blockchain entities.
 */
export default class DiscoveryHandler {
  constructor(connector) {
    this.connector = connector;
    this.db = connector.db;
    this.domainDiscovery = null;
  }

  setDomainDiscovery(domainDiscovery) {
    this.domainDiscovery = domainDiscovery;
  }

  routes() {
    const router = express.Router();

    /**
     * List indexed domains
     * GET /api/discovery
     */
    router.get('/', async (req, res) => {
      try {
        const entities = await this.db.collection('entities')
          .find({ type: 'AIDiscovery' })
          .sort({ _modified: -1 })
          .limit(100)
          .toArray();

        res.json({ domains: entities });
      } catch (error) {
        console.error('[discovery] Error listing:', error);
        res.status(500).json({ error: error.message });
      }
    });

    /**
     * Get full domain detail
     * GET /api/discovery/:domain
     */
    router.get('/:domain', async (req, res) => {
      try {
        const domain = req.params.domain;
        const entity = await this.db.collection('entities').findOne({
          address: domain,
          type: 'AIDiscovery'
        });

        if (!entity) {
          return res.status(404).json({ error: 'Domain not found' });
        }

        const domainRecord = await this.db.collection('domains').findOne({ domain });

        res.json({ entity, crawlState: domainRecord });
      } catch (error) {
        console.error('[discovery] Error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    /**
     * Submit a domain for discovery
     * POST /api/discovery
     * Body: { domain: "example.com" }
     */
    router.post('/', async (req, res) => {
      try {
        const { domain } = req.body;

        if (!domain) {
          return res.status(400).json({ error: 'Missing required field: domain' });
        }

        if (!this.domainDiscovery) {
          return res.status(503).json({ error: 'Discovery not initialized' });
        }

        // Check the domain immediately
        const entity = await this.domainDiscovery.checkDomain(domain);

        if (entity) {
          res.json({
            success: true,
            message: `Domain ${domain} indexed successfully`,
            entity
          });
        } else {
          res.json({
            success: false,
            message: `Domain ${domain} has no /.well-known/ai manifest`
          });
        }
      } catch (error) {
        console.error('[discovery] Error submitting domain:', error);
        res.status(500).json({ error: error.message });
      }
    });

    /**
     * Remove a domain
     * DELETE /api/discovery/:domain
     */
    router.delete('/:domain', async (req, res) => {
      try {
        const domain = req.params.domain;

        await this.db.collection('domains').updateOne(
          { domain },
          { $set: { active: false, _modified: new Date() } }
        );

        await this.db.collection('entities').deleteOne({
          address: domain,
          type: 'AIDiscovery'
        });

        res.json({
          success: true,
          message: `Domain ${domain} removed`
        });
      } catch (error) {
        console.error('[discovery] Error removing domain:', error);
        res.status(500).json({ error: error.message });
      }
    });

    /**
     * Trigger immediate re-check
     * POST /api/discovery/check
     * Body: { domain: "example.com" }
     */
    router.post('/check', async (req, res) => {
      try {
        const { domain } = req.body;

        if (!domain) {
          return res.status(400).json({ error: 'Missing required field: domain' });
        }

        if (!this.domainDiscovery) {
          return res.status(503).json({ error: 'Discovery not initialized' });
        }

        const entity = await this.domainDiscovery.checkDomain(domain);

        res.json({
          success: !!entity,
          message: entity ? `Domain ${domain} re-checked` : `No manifest found for ${domain}`,
          entity
        });
      } catch (error) {
        console.error('[discovery] Error checking domain:', error);
        res.status(500).json({ error: error.message });
      }
    });

    return router;
  }
}
