import express from 'express';

/**
 * EventHandler
 *
 * Query and analyze event data. Provides aggregation and filtering
 * similar to metric-server Pull handler.
 */
export default class EventHandler {
  constructor(connector) {
    this.connector = connector;
    this.db = connector.db;
  }

  routes() {
    const router = express.Router();

    /**
     * Query events
     * GET /api/events?entityId=0x123&type=agent.AccessGranted&limit=50
     */
    router.get('/', async (req, res) => {
      try {
        const {
          entityId,
          type,
          chain,
          from,
          to,
          limit = 50,
          skip = 0
        } = req.query;

        const query = {};

        if (entityId) query.entityId = entityId.toLowerCase();
        if (type) query.type = type;
        if (chain) query.chain = chain;

        // Time range filter
        if (from || to) {
          query.timestamp = {};
          if (from) query.timestamp.$gte = new Date(from);
          if (to) query.timestamp.$lte = new Date(to);
        }

        const events = await this.db.collection('events')
          .find(query)
          .sort({ timestamp: -1 })
          .skip(parseInt(skip))
          .limit(parseInt(limit))
          .toArray();

        const total = await this.db.collection('events').countDocuments(query);

        res.json({
          events,
          pagination: {
            total,
            limit: parseInt(limit),
            skip: parseInt(skip)
          }
        });
      } catch (error) {
        console.error('[events] Query error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    /**
     * Aggregate events
     * POST /api/events/aggregate
     * Body: MongoDB aggregation pipeline
     */
    router.post('/aggregate', async (req, res) => {
      try {
        const pipeline = req.body;

        if (!Array.isArray(pipeline)) {
          return res.status(400).json({ error: 'Pipeline must be an array' });
        }

        const results = await this.db.collection('events')
          .aggregate(pipeline)
          .toArray();

        res.json({ results });
      } catch (error) {
        console.error('[events] Aggregation error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    /**
     * Get event statistics
     * GET /api/events/stats
     */
    router.get('/stats', async (req, res) => {
      try {
        const { entityId, chain, type } = req.query;
        const match = {};

        if (entityId) match.entityId = entityId.toLowerCase();
        if (chain) match.chain = chain;
        if (type) match.type = type;

        const pipeline = [
          { $match: match },
          {
            $group: {
              _id: '$type',
              count: { $sum: 1 },
              firstSeen: { $min: '$timestamp' },
              lastSeen: { $max: '$timestamp' }
            }
          },
          { $sort: { count: -1 } }
        ];

        const stats = await this.db.collection('events')
          .aggregate(pipeline)
          .toArray();

        res.json({ stats });
      } catch (error) {
        console.error('[events] Stats error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    /**
     * Get timeline of events (for charts)
     * GET /api/events/timeline?entityId=0x123&interval=day
     */
    router.get('/timeline', async (req, res) => {
      try {
        const { entityId, chain, type, interval = 'day' } = req.query;
        const match = {};

        if (entityId) match.entityId = entityId.toLowerCase();
        if (chain) match.chain = chain;
        if (type) match.type = type;

        // Date grouping based on interval
        const dateFormat = {
          hour: { $dateToString: { format: '%Y-%m-%d %H:00', date: '$timestamp' } },
          day: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
          month: { $dateToString: { format: '%Y-%m', date: '$timestamp' } }
        };

        const pipeline = [
          { $match: match },
          {
            $group: {
              _id: dateFormat[interval] || dateFormat.day,
              count: { $sum: 1 }
            }
          },
          { $sort: { _id: 1 } }
        ];

        const timeline = await this.db.collection('events')
          .aggregate(pipeline)
          .toArray();

        res.json({ timeline });
      } catch (error) {
        console.error('[events] Timeline error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    return router;
  }
}
