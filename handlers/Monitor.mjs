import express from 'express';

/**
 * MonitorHandler
 *
 * Manages monitored addresses. Provides API to add/remove addresses to track.
 * This is called automatically when users search, or manually by epistery hosts
 * when they create new contracts.
 */
export default class MonitorHandler {
  constructor(connector) {
    this.connector = connector;
    this.db = connector.db;
    this.ingestion = null; // Will be set by main server
  }

  /**
   * Set the ingestion manager
   */
  setIngestion(ingestion) {
    this.ingestion = ingestion;
  }

  routes() {
    const router = express.Router();

    /**
     * Add a new monitor
     * POST /api/monitor
     * Body: { address, chain, type }
     */
    router.post('/', async (req, res) => {
      try {
        const { address, chain, type } = req.body;

        if (!address || !chain || !type) {
          return res.status(400).json({
            error: 'Missing required fields: address, chain, type'
          });
        }

        // Validate entity type against registry
        const validTypes = this.ingestion?.registry?.list() || [];
        if (!validTypes.includes(type)) {
          return res.status(400).json({
            error: `Invalid type. Must be one of: ${validTypes.join(', ')}`
          });
        }

        // Chain monitors poll RPC by address — a malformed one (a literal
        // "undefined" once landed here) just errors on every cycle.
        if (!/^0x[0-9a-f]{40}$/i.test(address)) {
          return res.status(400).json({ error: `Invalid contract address: ${address}` });
        }

        // Add monitor via ingestion manager
        if (!this.ingestion) {
          return res.status(503).json({ error: 'Ingestion not initialized' });
        }

        await this.ingestion.addMonitor(address, chain, type);

        res.json({
          success: true,
          message: `Monitor added for ${type} at ${address} on ${chain}`
        });
      } catch (error) {
        console.error('[monitor] Error adding monitor:', error);
        res.status(500).json({ error: error.message });
      }
    });

    /**
     * Remove a monitor
     * DELETE /api/monitor/:address[?chain=polygon]
     * Without ?chain, deactivates the address on every chain — the old
     * silent default of "ethereum" deactivated nothing and reported success.
     */
    router.delete('/:address', async (req, res) => {
      try {
        const address = req.params.address.toLowerCase();
        const chain = req.query.chain;

        if (!this.ingestion) {
          return res.status(503).json({ error: 'Ingestion not initialized' });
        }

        let removed;
        if (chain) {
          await this.ingestion.removeMonitor(address, chain);
          removed = `${address} on ${chain}`;
        } else {
          const result = await this.db.collection('monitors').updateMany(
            { address, active: true },
            { $set: { active: false, _modified: new Date() } }
          );
          removed = `${address} on ${result.modifiedCount} chain${result.modifiedCount === 1 ? '' : 's'}`;
        }

        res.json({ success: true, message: `Monitor removed for ${removed}` });
      } catch (error) {
        console.error('[monitor] Error removing monitor:', error);
        res.status(500).json({ error: error.message });
      }
    });

    /**
     * List all monitors
     * GET /api/monitor
     */
    router.get('/', async (req, res) => {
      try {
        const monitors = await this.db.collection('monitors')
          .find({ active: true })
          .toArray();

        res.json({ monitors });
      } catch (error) {
        console.error('[monitor] Error listing monitors:', error);
        res.status(500).json({ error: error.message });
      }
    });

    /**
     * Get monitor status
     * GET /api/monitor/:address
     */
    router.get('/:address', async (req, res) => {
      try {
        const address = req.params.address.toLowerCase();
        const chain = req.query.chain || 'ethereum';

        const monitor = await this.db.collection('monitors').findOne({ address, chain });
        if (!monitor) {
          return res.status(404).json({ error: 'Monitor not found' });
        }

        const entity = await this.db.collection('entities').findOne({ address });
        const eventCount = await this.db.collection('events').countDocuments({ entityId: address });

        res.json({
          monitor,
          entity,
          stats: {
            totalEvents: eventCount,
            lastProcessedBlock: entity?.lastProcessedBlock
          }
        });
      } catch (error) {
        console.error('[monitor] Error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    return router;
  }
}
