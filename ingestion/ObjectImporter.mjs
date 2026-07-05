import { engineFor } from './sources/index.mjs';
import { keywords } from './sources/util.mjs';
import { mapFor, projectSearch, projectCard } from '../lib/SchemaMaps.mjs';

/**
 * ObjectImporter
 *
 * Drives the per-source import engines: pages each data source's catalog,
 * normalizes every object into the shared signed-object shape, and bulk-upserts
 * it into the entities collection for global search.
 *
 * Normalized object (one entity per source object):
 *   address: "<source>:<objectId>"          — source stays visible in the key
 *   type:    "Object"
 *   metadata.source: { name, label, domain, url, author, trustScore, importedAt }
 *   metadata.object: { type, title, summary, keywords }   — normalized, indexed
 *   metadata.fields: <raw author object>                  — author's intent, verbatim
 *
 * The DomainDiscovery instance supplies the registered data sources (with their
 * synced skill manifests) and a fetchJSON helper that already handles timeouts
 * and redirects.
 */
export default class ObjectImporter {
  constructor(database, domainDiscovery, config = {}) {
    this.database = database;
    this.domainDiscovery = domainDiscovery;
    this.pollInterval = config.pollInterval || 21600000; // 6 hours
    this.isRunning = false;
    this.pollTimer = null;
    this._importing = false; // guard against overlapping runs
  }

  /** Data sources that have an import engine — named adapter or declared catalog. */
  _importable() {
    const sources = this.domainDiscovery?.dataSources || [];
    return sources
      .map(ds => ({ ds, engine: engineFor(ds.name, ds.skillManifest) }))
      .filter(x => x.engine);
  }

  /**
   * Look up the trust score the source domain earned via normal AI discovery,
   * so every object inherits its source's signed posture. One lookup per source.
   */
  async _sourceTrust(domain) {
    try {
      const entity = await this.database.getEntity(domain);
      return entity?.metadata?.trustScore ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Build a normalized object entity from one raw source object.
   *
   * The engine projects the raw object into JSON-LD (or passes it through when
   * the source is JSON-LD native); the public schema map for its @type then
   * declares how that object is structured for search (title/summary/keywords)
   * and display (image, facets). Scan projects structure — it never derives an
   * ontology of its own. The author's raw object stays verbatim in fields.
   */
  _normalize(ds, engine, raw, sourceMeta) {
    const id = engine.id(raw);
    if (id == null || id === '') return null;
    const jsonld = engine.jsonld(raw, ds.url);
    if (!jsonld) return null;

    const schema = engine.schemaOf ? engine.schemaOf(raw) : engine.schema;
    const map = mapFor(schema);
    const digest = map
      ? projectSearch(map, jsonld)
      : { title: jsonld.name || null, summary: jsonld.description || null, keywords: [jsonld.name] };
    if (!digest.title) return null;
    const card = map ? projectCard(map, jsonld) : null;

    return {
      address: `${ds.name}:${id}`,
      type: 'Object',
      chain: 'web',
      metadata: {
        source: {
          name: ds.name,
          label: ds.label,
          domain: ds.domain,
          url: jsonld.url || `https://${ds.domain}`,
          author: sourceMeta.author,
          trustScore: sourceMeta.trustScore,
          importedAt: new Date()
        },
        object: {
          type: engine.objectType || map?.label?.toLowerCase() || 'object',
          schema: schema || null,
          title: digest.title,
          summary: digest.summary || null,
          keywords: keywords(...(digest.keywords || []), ...(ds.topics || [])),
          jsonld,
          image: card?.image || null
        },
        fields: raw
      }
    };
  }

  /**
   * Import every object from one data source. Pages until the source is
   * exhausted (or `cap` objects have been imported). Returns the count.
   */
  async importSource(ds, engine, { cap = Infinity } = {}) {
    const fetchJSON = this.domainDiscovery.fetchJSON.bind(this.domainDiscovery);
    const limit = engine.pageSize || 500;

    // Author + trust come from the source's signed manifest / discovery entity.
    const manifest = ds.skillManifest || {};
    const author = manifest._signature?.digitalName || manifest.signing?.address || null;
    const trustScore = await this._sourceTrust(ds.domain);
    const sourceMeta = { author, trustScore };

    let offset = 0;
    let total = Infinity;
    let imported = 0;

    console.log(`[import] ${ds.name}: starting import from ${ds.domain}`);

    while (offset < total && imported < cap) {
      const url = engine.listUrl(ds.url, offset, limit);
      const resp = await fetchJSON(url);
      if (!resp) {
        console.warn(`[import] ${ds.name}: no response at offset ${offset}, stopping`);
        break;
      }

      total = engine.total(resp) || 0;
      const arr = resp[engine.objectsKey] || [];
      if (!Array.isArray(arr) || arr.length === 0) break;

      const docs = arr
        .map(o => this._normalize(ds, engine, o, sourceMeta))
        .filter(Boolean);
      if (docs.length) await this.database.bulkUpsertObjects(docs);

      imported += docs.length;
      offset += arr.length;

      if (imported % 5000 < arr.length) {
        console.log(`[import] ${ds.name}: ${imported}/${Math.min(total, cap)} objects`);
      }

      if (arr.length < limit) break; // last page
    }

    console.log(`[import] ${ds.name}: done — ${imported} objects indexed`);
    return imported;
  }

  /**
   * Import all importable sources (or a single named one). `cap` bounds the
   * objects taken per source — useful for a controlled first run.
   */
  async importAll({ name = null, cap = Infinity } = {}) {
    if (this._importing) {
      console.warn('[import] Import already in progress, skipping');
      return { skipped: true };
    }
    this._importing = true;
    const results = {};
    try {
      let targets = this._importable();
      if (name) targets = targets.filter(t => t.ds.name === name);
      if (targets.length === 0) {
        console.warn(`[import] No importable source${name ? ` named "${name}"` : 's'} found`);
        return { results };
      }
      for (const { ds, engine } of targets) {
        try {
          results[ds.name] = await this.importSource(ds, engine, { cap });
        } catch (err) {
          console.error(`[import] ${ds.name}: import failed:`, err.message);
          results[ds.name] = { error: err.message };
        }
      }
    } finally {
      this._importing = false;
    }
    return { results };
  }

  /** Start periodic full re-import. */
  start() {
    if (this.isRunning) return;
    if (this._importable().length === 0) {
      console.log('[import] No importable data sources — object import disabled');
      return;
    }
    this.isRunning = true;
    console.log(`[import] Starting object import (interval: ${this.pollInterval}ms)`);
    this.pollTimer = setInterval(() => {
      this.importAll().catch(err => console.error('[import] Poll error:', err.message));
    }, this.pollInterval);
    // Kick off an initial import in the background
    this.importAll().catch(err => console.error('[import] Initial import error:', err.message));
  }

  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    console.log('[import] Stopped object import');
  }
}
