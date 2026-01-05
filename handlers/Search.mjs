import express from 'express';

/**
 * SearchHandler
 *
 * Provides search functionality like Etherscan - users can search for addresses,
 * transactions, or other identifiers. Control automatically informs Ingestion
 * of what to monitor based on what people search for.
 */
export default class SearchHandler {
  constructor(connector) {
    this.connector = connector;
    this.db = connector.db;
  }

  routes() {
    const router = express.Router();

    /**
     * Search for an address or transaction
     * GET /api/search?q=0x123...
     */
    router.get('/', async (req, res) => {
      try {
        const query = req.query.q;
        if (!query) {
          return res.status(400).json({ error: 'Query parameter "q" is required' });
        }

        const results = await this.search(query);
        res.json(results);
      } catch (error) {
        console.error('[search] Error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    /**
     * Get details for a specific address
     * GET /api/search/address/:address
     */
    router.get('/address/:address', async (req, res) => {
      try {
        const address = req.params.address.toLowerCase();
        const chain = req.query.chain || 'ethereum';

        const entity = await this.db.collection('entities').findOne({ address });
        const events = await this.db.collection('events')
          .find({ entityId: address })
          .sort({ timestamp: -1 })
          .limit(50)
          .toArray();

        res.json({
          entity,
          events,
          stats: {
            totalEvents: await this.db.collection('events').countDocuments({ entityId: address }),
            firstSeen: entity?._created,
            lastActivity: events[0]?.timestamp
          }
        });
      } catch (error) {
        console.error('[search] Error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    /**
     * Get details for a transaction
     * GET /api/search/tx/:hash
     */
    router.get('/tx/:hash', async (req, res) => {
      try {
        const txHash = req.params.hash;
        const events = await this.db.collection('events')
          .find({ 'data.transactionHash': txHash })
          .sort({ timestamp: -1 })
          .toArray();

        res.json({
          transactionHash: txHash,
          events
        });
      } catch (error) {
        console.error('[search] Error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    return router;
  }

  /**
   * Search logic - determines what the query is (address, tx, etc.)
   */
  async search(query) {
    const results = {
      query,
      entities: [],
      transactions: [],
      events: []
    };

    // Normalize query
    const q = query.toLowerCase().trim();

    // Check if it's an address (0x followed by 40 hex chars)
    if (/^0x[a-f0-9]{40}$/i.test(q)) {
      const entity = await this.db.collection('entities').findOne({ address: q });
      if (entity) {
        results.entities.push(entity);
      } else {
        // Not in database yet - return suggestion to monitor
        results.suggestion = {
          type: 'address',
          value: q,
          message: 'Address not found. Would you like to monitor it?'
        };
      }
    }
    // Check if it's a transaction hash (0x followed by 64 hex chars)
    else if (/^0x[a-f0-9]{64}$/i.test(q)) {
      const events = await this.db.collection('events')
        .find({ 'data.transactionHash': q })
        .toArray();
      results.transactions = events;
    }
    // General text search
    else {
      // Search in entity metadata (domain names, etc.)
      const entities = await this.db.collection('entities')
        .find({
          $or: [
            { 'metadata.domain': new RegExp(q, 'i') },
            { 'metadata.owner': new RegExp(q, 'i') }
          ]
        })
        .limit(20)
        .toArray();
      results.entities = entities;
    }

    return results;
  }
}
