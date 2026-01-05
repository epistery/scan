/**
 * Database layer for Epistery Scan
 *
 * Manages two main collections:
 * - entities: Structured data organized by type (Agent, IdentityContract, CampaignWallet)
 * - events: Loosely typed event records with timestamp, source, entityId, type, and arbitrary attributes
 */
export default class Database {
  constructor(connector) {
    this.connector = connector;
    this.db = connector.db;

    // Collections
    this.entities = this.db.collection('entities');
    this.events = this.db.collection('events');
    this.monitors = this.db.collection('monitors');
  }

  /**
   * Initialize database indexes
   */
  async initialize() {
    // Entity indexes
    await this.entities.createIndex({ address: 1 }, { unique: true });
    await this.entities.createIndex({ type: 1 });
    await this.entities.createIndex({ chain: 1 });
    await this.entities.createIndex({ 'metadata.domain': 1 });

    // Event indexes for efficient querying
    await this.events.createIndex({ timestamp: -1 });
    await this.events.createIndex({ entityId: 1, timestamp: -1 });
    await this.events.createIndex({ type: 1, timestamp: -1 });
    await this.events.createIndex({ source: 1, timestamp: -1 });
    await this.events.createIndex({ chain: 1, timestamp: -1 });

    // Monitor indexes
    await this.monitors.createIndex({ address: 1, chain: 1 }, { unique: true });
    await this.monitors.createIndex({ active: 1 });
    await this.monitors.createIndex({ type: 1 });

    console.log('[db] Database indexes created');
  }

  /**
   * Save or update an entity
   */
  async saveEntity(entity) {
    const now = new Date();
    const doc = {
      ...entity,
      _modified: now,
      _id: entity.address
    };

    if (!doc._created) {
      doc._created = now;
    }

    const result = await this.entities.replaceOne(
      { address: entity.address },
      doc,
      { upsert: true }
    );

    return doc;
  }

  /**
   * Get entity by address
   */
  async getEntity(address) {
    return await this.entities.findOne({ address });
  }

  /**
   * Search entities
   */
  async searchEntities(query = {}, options = {}) {
    const limit = options.limit || 50;
    const skip = options.skip || 0;

    const cursor = this.entities
      .find(query)
      .sort({ _modified: -1 })
      .skip(skip)
      .limit(limit);

    return await cursor.toArray();
  }

  /**
   * Record an event
   */
  async recordEvent(event) {
    const doc = {
      _id: this.connector.idForge.datedId(),
      timestamp: event.timestamp || new Date(),
      source: event.source,
      entityId: event.entityId,
      type: event.type,
      chain: event.chain,
      ...event.data
    };

    const result = await this.events.insertOne(doc);
    return doc;
  }

  /**
   * Bulk record events
   */
  async recordEvents(events) {
    const docs = events.map(event => ({
      _id: this.connector.idForge.datedId(),
      timestamp: event.timestamp || new Date(),
      source: event.source,
      entityId: event.entityId,
      type: event.type,
      chain: event.chain,
      ...event.data
    }));

    const result = await this.events.insertMany(docs);
    return docs;
  }

  /**
   * Query events with aggregation
   */
  async queryEvents(query = {}, options = {}) {
    const limit = options.limit || 100;
    const skip = options.skip || 0;

    const cursor = this.events
      .find(query)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit);

    return await cursor.toArray();
  }

  /**
   * Get events for a specific entity
   */
  async getEntityEvents(entityId, options = {}) {
    return await this.queryEvents({ entityId }, options);
  }

  /**
   * Aggregate events (for analytics)
   */
  async aggregateEvents(pipeline) {
    const cursor = this.events.aggregate(pipeline);
    return await cursor.toArray();
  }

  /**
   * Add or update a monitor (address to track)
   */
  async addMonitor(monitor) {
    const now = new Date();
    const doc = {
      address: monitor.address,
      chain: monitor.chain,
      type: monitor.type,
      active: monitor.active !== false,
      metadata: monitor.metadata || {},
      _created: now,
      _modified: now
    };

    const result = await this.monitors.replaceOne(
      { address: monitor.address, chain: monitor.chain },
      doc,
      { upsert: true }
    );

    return doc;
  }

  /**
   * Get all active monitors
   */
  async getActiveMonitors() {
    return await this.monitors.find({ active: true }).toArray();
  }

  /**
   * Get monitors by type
   */
  async getMonitorsByType(type) {
    return await this.monitors.find({ type, active: true }).toArray();
  }

  /**
   * Deactivate a monitor
   */
  async deactivateMonitor(address, chain) {
    return await this.monitors.updateOne(
      { address, chain },
      { $set: { active: false, _modified: new Date() } }
    );
  }
}
