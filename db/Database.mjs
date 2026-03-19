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
    this.transactions = this.db.collection('transactions');
    this.domains = this.db.collection('domains');
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

    // Transaction indexes
    await this.transactions.createIndex({ hash: 1, chain: 1 }, { unique: true });
    await this.transactions.createIndex({ from: 1 });
    await this.transactions.createIndex({ to: 1 });
    await this.transactions.createIndex({ blockNumber: -1 });
    await this.transactions.createIndex({ timestamp: -1 });

    // Domain indexes (AI discovery crawl state)
    await this.domains.createIndex({ domain: 1 }, { unique: true });
    await this.domains.createIndex({ active: 1 });
    await this.domains.createIndex({ lastChecked: 1 });

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

    // Case-insensitive query to find existing entity
    const addressRegex = new RegExp(`^${entity.address}$`, 'i');
    const result = await this.entities.replaceOne(
      { address: addressRegex },
      doc,
      { upsert: true }
    );

    return doc;
  }

  /**
   * Get entity by address (case-insensitive)
   */
  async getEntity(address) {
    const addressRegex = new RegExp(`^${address}$`, 'i');
    return await this.entities.findOne({ address: addressRegex });
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
      ...this.convertBigInt(event.data)
    };

    const result = await this.events.insertOne(doc);
    return doc;
  }

  /**
   * Convert BigInt values to Number recursively
   */
  convertBigInt(obj) {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'bigint') return Number(obj);
    if (Array.isArray(obj)) return obj.map(item => this.convertBigInt(item));
    if (typeof obj === 'object') {
      const converted = {};
      for (const [key, value] of Object.entries(obj)) {
        converted[key] = this.convertBigInt(value);
      }
      return converted;
    }
    return obj;
  }

  /**
   * Bulk record events
   */
  async recordEvents(events) {
    const docs = events.map(event => {
      const doc = {
        _id: this.connector.idForge.datedId(),
        timestamp: event.timestamp || new Date(),
        source: event.source,
        entityId: event.entityId,
        type: event.type,
        chain: event.chain,
        ...this.convertBigInt(event.data)
      };
      return doc;
    });

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

  /**
   * Save or update a transaction
   */
  async saveTransaction(transaction, chain) {
    const now = new Date();
    const doc = {
      _id: transaction.hash,
      chain,
      ...transaction,
      _modified: now
    };

    if (!doc._created) {
      doc._created = now;
    }

    // Case-insensitive query to find existing transaction
    const hashRegex = new RegExp(`^${transaction.hash}$`, 'i');
    const result = await this.transactions.replaceOne(
      { hash: hashRegex, chain },
      doc,
      { upsert: true }
    );

    return doc;
  }

  /**
   * Get transactions for an address
   */
  /**
   * Add or update a domain for AI discovery tracking
   */
  async addDomain(domainRecord) {
    const now = new Date();
    const doc = {
      domain: domainRecord.domain,
      active: domainRecord.active !== false,
      discoveredFrom: domainRecord.discoveredFrom || null,
      status: domainRecord.status || 'pending',
      lastChecked: domainRecord.lastChecked || null,
      nextCheck: domainRecord.nextCheck || now,
      _created: now,
      _modified: now
    };

    await this.domains.replaceOne(
      { domain: domainRecord.domain },
      doc,
      { upsert: true }
    );

    return doc;
  }

  /**
   * Get a domain record
   */
  async getDomain(domain) {
    return await this.domains.findOne({ domain });
  }

  /**
   * Get all active domains due for checking
   */
  async getActiveDomains() {
    return await this.domains.find({
      active: true,
      nextCheck: { $lte: new Date() }
    }).toArray();
  }

  /**
   * Deactivate a domain
   */
  async deactivateDomain(domain) {
    return await this.domains.updateOne(
      { domain },
      { $set: { active: false, _modified: new Date() } }
    );
  }

  async getTransactionsForAddress(address, options = {}) {
    const limit = options.limit || 50;
    const skip = options.skip || 0;
    const addressRegex = new RegExp(`^${address}$`, 'i');

    const cursor = this.transactions
      .find({
        $or: [
          { from: addressRegex },
          { to: addressRegex }
        ]
      })
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit);

    return await cursor.toArray();
  }
}
