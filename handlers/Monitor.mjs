import express from 'express';

const RESYNC_MS = 30_000;

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
    this.resynced = new Map(); // address -> when it was last re-read on request
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
     * Re-read a monitored entity now (see IngestionManager.resync).
     * POST /api/monitor/:address/sync
     * One re-read per address per RESYNC_MS: a sync is several RPC view calls,
     * and an unauthenticated route that spends them must not be a spigot.
     */
    router.post('/:address/sync', async (req, res) => {
      try {
        const address = req.params.address.toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(address)) return res.status(400).json({ error: 'Invalid address format' });
        if (!this.ingestion) return res.status(503).json({ error: 'Ingestion not initialized' });
        const last = this.resynced.get(address) || 0;
        if (Date.now() - last < RESYNC_MS) {
          return res.status(429).json({ error: 'Re-read recently; try again shortly', retryAfter: Math.ceil((last + RESYNC_MS - Date.now()) / 1000) });
        }
        this.resynced.set(address, Date.now());
        if (!(await this.ingestion.resync(address))) return res.status(404).json({ error: 'Monitor not found' });
        res.json({ success: true, synced: address });
      } catch (error) {
        console.error('[monitor] Resync error:', error);
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
        // No invented chain: without ?chain the monitor is found by its address
        // on whichever chain holds it — the same rule DELETE follows. (The old
        // silent default of "ethereum" answered "not found" for every monitor on
        // any other chain.)
        const chain = req.query.chain;

        const monitor = await this.db.collection('monitors').findOne(chain ? { address, chain } : { address });
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
