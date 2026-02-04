import express from 'express';

/**
 * FetchHandler
 *
 * On-demand data fetching - no automatic polling.
 * Allows precise control over what data is fetched and when.
 */
export default class FetchHandler {
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
     * Fetch events for a specific contract
     * POST /api/fetch/events
     * Body: { address, chain, fromBlock, toBlock }
     */
    router.post('/events', async (req, res) => {
      try {
        const { address, chain, fromBlock, toBlock } = req.body;

        if (!address || !chain) {
          return res.status(400).json({ error: 'address and chain are required' });
        }

        if (!this.ingestion) {
          return res.status(500).json({ error: 'Ingestion manager not available' });
        }

        // Get or create monitor
        let monitor = await this.db.collection('monitors').findOne({
          address: new RegExp(`^${address}$`, 'i'),
          chain
        });

        if (!monitor) {
          // Create monitor
          monitor = await this.db.collection('monitors').insertOne({
            address,
            chain,
            type: 'Agent',
            active: true,
            metadata: {},
            _created: new Date(),
            _modified: new Date()
          });

          monitor = await this.db.collection('monitors').findOne({ address, chain });
        }

        // Fetch events for specific block range
        console.log(`[fetch] Fetching events for ${address} on ${chain} from block ${fromBlock || 'latest-1000'} to ${toBlock || 'latest'}`);

        const result = await this.ingestion.processMonitor(monitor, fromBlock, toBlock);

        res.json({
          success: true,
          address,
          chain,
          fromBlock: fromBlock || result.fromBlock,
          toBlock: toBlock || result.toBlock,
          eventsProcessed: result.eventsProcessed || 0,
          message: 'Events fetched successfully'
        });

      } catch (error) {
        console.error('[fetch] Error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    /**
     * Fetch transaction details
     * POST /api/fetch/transaction
     * Body: { hash, chain }
     */
    router.post('/transaction', async (req, res) => {
      try {
        const { hash, chain } = req.body;

        if (!hash || !chain) {
          return res.status(400).json({ error: 'hash and chain are required' });
        }

        if (!this.ingestion || !this.ingestion.connectors[chain]) {
          return res.status(400).json({ error: `Chain ${chain} not configured` });
        }

        const connector = this.ingestion.connectors[chain];
        const txDetails = await connector.getTransactionDetails(hash);

        if (!txDetails) {
          return res.status(404).json({ error: 'Transaction not found' });
        }

        // Save to database
        const database = this.ingestion.database;
        await database.saveTransaction(txDetails, chain);

        res.json({
          success: true,
          transaction: txDetails
        });

      } catch (error) {
        console.error('[fetch] Error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    /**
     * Get current block for a chain
     * GET /api/fetch/block-number?chain=polygon
     */
    router.get('/block-number', async (req, res) => {
      try {
        const { chain } = req.query;

        if (!chain) {
          return res.status(400).json({ error: 'chain is required' });
        }

        if (!this.ingestion || !this.ingestion.connectors[chain]) {
          return res.status(400).json({ error: `Chain ${chain} not configured` });
        }

        const connector = this.ingestion.connectors[chain];
        const blockNumber = await connector.getCurrentBlock();

        res.json({
          chain,
          blockNumber
        });

      } catch (error) {
        console.error('[fetch] Error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    return router;
  }
}
