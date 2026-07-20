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

    // Full-text index for knowledge search across manifest content + epistery-app
    // identities. Mongo allows only ONE text index per collection, so when the
    // field set changes we must drop and recreate it (see ensureTextIndex).
    const textSpec = {
      'metadata.manifest.organization.name': 'text',
      'metadata.manifest.organization.mission': 'text',
      'metadata.manifest.organization.description': 'text',
      'metadata.manifest.organization.tagline': 'text',
      'metadata.manifest.coreConcepts.term': 'text',
      'metadata.manifest.coreConcepts.definition': 'text',
      'metadata.manifest.applications.name': 'text',
      'metadata.manifest.applications.description': 'text',
      'metadata.manifest.people.name': 'text',
      'metadata.manifest.people.role': 'text',
      // epistery-app identities (see ingestion/AppDirectory.mjs)
      'metadata.app.name': 'text',
      'metadata.app.domain': 'text',
      'metadata.app.description': 'text',
      'metadata.app.sessions.name': 'text',
      'metadata.app.sessions.description': 'text',
      // normalized signed objects ingested from data sources (see ingestion/ObjectImporter.mjs)
      'metadata.object.title': 'text',
      'metadata.object.keywords': 'text',
      'metadata.object.summary': 'text',
      address: 'text'
    };
    const textOpts = {
      name: 'knowledge_search',
      weights: {
        'metadata.manifest.organization.name': 10,
        'metadata.app.name': 10,
        'metadata.manifest.coreConcepts.term': 8,
        'metadata.manifest.applications.name': 6,
        'metadata.app.sessions.name': 6,
        'metadata.manifest.organization.mission': 5,
        'metadata.manifest.coreConcepts.definition': 4,
        'metadata.app.description': 4,
        'metadata.app.sessions.description': 3,
        'metadata.manifest.applications.description': 3,
        'metadata.manifest.organization.description': 3,
        'metadata.app.domain': 3,
        'metadata.manifest.people.name': 2,
        'metadata.manifest.people.role': 1,
        'metadata.manifest.organization.tagline': 2,
        'metadata.object.title': 9,
        'metadata.object.keywords': 7,
        'metadata.object.summary': 4,
        address: 1
      }
    };
    await this.ensureTextIndex(textSpec, textOpts);

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

    // Trust score index for posture queries
    await this.entities.createIndex({ 'metadata.trustScore': 1 });

    // Capability index for query routing
    await this.entities.createIndex({ 'metadata.capabilities.keywords': 1 });

    // Normalized signed-object lookups (filter/group by source, object type, schema)
    await this.entities.createIndex({ 'metadata.source.name': 1 });
    await this.entities.createIndex({ 'metadata.object.type': 1 });
    await this.entities.createIndex({ 'metadata.object.schema': 1 });

    // epistery-app identity lookups (exact name + owner)
    await this.entities.createIndex({ 'metadata.app.nameLower': 1 });
    await this.entities.createIndex({ 'metadata.app.owner': 1 });

    // Domain indexes (AI discovery crawl state)
    await this.domains.createIndex({ domain: 1 }, { unique: true });
    await this.domains.createIndex({ active: 1 });
    await this.domains.createIndex({ lastChecked: 1 });

    await this.normalizeAddressCase();

    console.log('[db] Database indexes created');
  }

  /**
   * Heal address-case drift. Historically some writers stored checksummed 0x
   * addresses while others stored lowercase, so one contract could hold two
   * rows differing only by case (both satisfy the unique index — different
   * strings). The convention is now lowercase-on-write (see saveEntity); this
   * idempotent boot pass converges existing data:
   *  - a mixed-case row with a lowercase twin merges into ONE row, preferring
   *    the interpreter-typed row over a bare live-RPC Contract/Wallet stub and
   *    keeping the earliest _created;
   *  - a mixed-case row with no twin is simply lowercased;
   *  - mixed-case event entityIds are lowercased so per-entity event queries
   *    (exact match) see the whole history.
   */
  async normalizeAddressCase() {
    const mixed = await this.entities.find({ address: /[A-Z]/ }).toArray();
    let merged = 0, renamed = 0;
    for (const row of mixed) {
      const lower = row.address.toLowerCase();
      const twin = await this.entities.findOne({ address: lower });
      if (twin) {
        const bare = (t) => t === 'Contract' || t === 'Wallet';
        const keep = bare(row.type) && !bare(twin.type) ? twin : row;
        const drop = keep === row ? twin : row;
        const created = [keep._created, drop._created].filter(Boolean).sort()[0] || null;
        await this.entities.deleteOne({ _id: drop._id });
        await this.entities.updateOne(
          { _id: keep._id },
          { $set: { address: lower, ...(created ? { _created: created } : {}) } }
        );
        merged++;
      } else {
        await this.entities.updateOne({ _id: row._id }, { $set: { address: lower } });
        renamed++;
      }
    }
    const events = await this.events.updateMany(
      { entityId: /[A-Z]/ },
      [{ $set: { entityId: { $toLower: '$entityId' } } }]
    );
    if (merged || renamed || events.modifiedCount) {
      console.log(`[db] Address case normalized: ${merged} merged, ${renamed} renamed, ${events.modifiedCount} events`);
    }
  }

  /**
   * Ensure the single text index matches `spec`. Mongo permits only one text
   * index per collection and rejects a createIndex whose key spec differs from
   * the existing one (code 85/86). When that happens we drop the old index and
   * recreate it with the new field set.
   */
  async ensureTextIndex(spec, opts) {
    try {
      await this.entities.createIndex(spec, opts);
    } catch (e) {
      const conflict = e.code === 85 || e.code === 86 || /text index|already exists/i.test(e.message || '');
      if (!conflict) throw e;
      await this.entities.dropIndex(opts.name).catch(() => {});
      await this.entities.createIndex(spec, opts);
    }
  }

  /**
   * Merge an epistery-app identity into the entities collection.
   *
   * Keyed on address (case-insensitive). App data lives under `metadata.app`
   * and never clobbers an existing entity's type or other metadata — so a
   * contract already indexed on-chain as an IdentityContract simply gains an
   * `app` block. `type: 'AppIdentity'` is stamped only when inserting a fresh
   * row. See ingestion/AppDirectory.mjs.
   */
  async saveAppIdentity({ address, chain, app }) {
    const now = new Date();
    const addressRegex = new RegExp(`^${address}$`, 'i');

    const setOnInsert = { address: address.toLowerCase(), type: 'AppIdentity', _created: now };
    if (chain) setOnInsert.chain = chain;

    await this.entities.updateOne(
      { address: addressRegex },
      {
        $set: { 'metadata.app': app, _modified: now },
        $setOnInsert: setOnInsert
      },
      { upsert: true }
    );
  }

  /**
   * Save or update an entity.
   *
   * Uses address (unique indexed) as the lookup key. Do NOT set `_id` — Mongo
   * forbids changing an existing document's _id, which previously caused
   * monitors to fail every cycle and re-hit the RPC.
   *
   * The stored address is ALWAYS lowercased — the collection's one case
   * convention. Callers pass checksummed 0x addresses freely; storing them
   * verbatim while other writers store lowercase produced case-twin duplicate
   * rows (the unique index treats them as different strings). Display
   * checksumming is presentation, done at projection time.
   */
  async saveEntity(entity) {
    const now = new Date();
    const addressRegex = new RegExp(`^${entity.address}$`, 'i');
    const existing = await this.entities.findOne({ address: addressRegex });

    const doc = {
      ...entity,
      address: entity.address.toLowerCase(),
      _created: existing?._created || now,
      _modified: now
    };
    // Strip _id — replaceOne preserves the existing _id on update, and on
    // insert Mongo generates one. Setting it ourselves fights both paths.
    delete doc._id;

    await this.entities.replaceOne(
      { address: addressRegex },
      doc,
      { upsert: true }
    );

    return doc;
  }

  /**
   * Bulk upsert normalized signed objects (see ingestion/ObjectImporter.mjs).
   *
   * Keyed on the lowercased, source-prefixed address ("vehicles:<vin>"), so a
   * re-import refreshes an object in place without duplicating it. metadata is
   * replaced wholesale each pass — objects carry no externally-set fields, so
   * there is nothing to preserve across imports.
   */
  async bulkUpsertObjects(docs) {
    if (!docs || docs.length === 0) return { upserted: 0, modified: 0 };
    const now = new Date();
    const ops = docs.map(d => {
      const address = d.address.toLowerCase();
      return {
        updateOne: {
          filter: { address },
          update: {
            $set: { type: d.type, chain: d.chain, metadata: d.metadata, _modified: now },
            $setOnInsert: { address, _created: now }
          },
          upsert: true
        }
      };
    });
    const res = await this.entities.bulkWrite(ops, { ordered: false });
    return { upserted: res.upsertedCount || 0, modified: res.modifiedCount || 0 };
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
      discoveryMethod: domainRecord.discoveryMethod || null,
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
