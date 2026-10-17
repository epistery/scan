/**
 * HostIndex — what scan's own index and crawl hold for a host.
 *
 * The index half of a domain report (DomainReport.mjs), as facts with a time:
 *
 *   - indexed entities for the host (manifest, domain agent) — origin facts
 *     from the strongest, by the one derivation in Present.mjs;
 *   - otherwise the discovery crawl's own record: scan looked for a
 *     /.well-known/ai (native, link-tag, ai. subdomain, _ai TXT) and found
 *     none, at a time — `manifest: { present: false, at }`;
 *   - otherwise a bounded discovery run now. A host that does publish is
 *     indexed by that run and answers with its real facts; one slower than
 *     the bound keeps crawling in the background and answers next time.
 *   - indexed entities on the parent or a subdomain of the host. They are
 *     related, never inherited: a chain-bound michael.sprague.com proves
 *     nothing about sprague.com.
 *
 * The rung is never raised by anything but the host's own proven signals.
 */
import { originFacts, rungFromSignals, stampOriginClaims } from '../lib/Present.mjs';

// Entity types that name a host: a manifest (address = domain) and a domain
// agent contract (metadata.domain). Also bounds the subdomain scan to them.
const HOSTED_TYPES = ['AIDiscovery', 'Agent'];
const RUNG_ORDER = ['open', 'claimed', 'dns', 'chain-bound'];

export default class HostIndex {
  constructor(db, domainDiscovery, { wait = 3000 } = {}) {
    this.db = db;
    this.discovery = domainDiscovery || null;
    this.wait = wait;
  }

  /** Facts for each host, in parallel. Returns Map host → facts. */
  async hosts(hosts) {
    const facts = await Promise.all(hosts.map(h => this.host(h)));
    return new Map(facts.map(f => [f.host, f]));
  }

  // crawl=false when the name does not resolve: there is no site to crawl.
  async host(host, { crawl = true } = {}) {
    let entities = await this._entitiesFor(host);
    let probe = { status: 'indexed', at: null };
    if (entities.length === 0) {
      probe = crawl ? await this._probe(host) : { status: 'unchecked', at: null };
      if (probe.status === 'indexed') entities = await this._entitiesFor(host);
    }
    await stampOriginClaims(this.db, entities);
    const strongest = entities.reduce((best, e) => (!best || rankOf(e) > rankOf(best)) ? e : best, null);
    return {
      host,
      entities,
      origin: strongest ? originFacts(strongest) : unindexedOrigin(probe),
      probe,
      related: await this._related(host, entities)
    };
  }

  _entitiesFor(host) {
    return this.db.collection('entities').find({
      type: { $in: HOSTED_TYPES },
      $or: [{ address: host }, { 'metadata.domain': host }]
    }).toArray();
  }

  /**
   * The crawl's own answer for an unindexed host: a recent no-manifest record
   * stands (re-probing it every search is noise); otherwise discovery runs,
   * bounded — it continues past the bound and indexes for next time.
   */
  async _probe(host) {
    const record = await this.db.collection('domains').findOne({ domain: host });
    const fresh = record?.lastChecked && (Date.now() - new Date(record.lastChecked).getTime()) < (this.discovery?.pollInterval || 0);
    if (fresh && record.status === 'no-manifest') return { status: 'no-manifest', at: record.lastChecked };
    if (!this.discovery) return { status: 'unchecked', at: null };

    const run = this.discovery.checkDomain(host);
    run.catch(err => console.warn(`[host-index] discovery of ${host} failed:`, err.message));
    let timer;
    const bound = new Promise(resolve => { timer = setTimeout(() => resolve('pending'), this.wait); });
    const outcome = await Promise.race([run.then(e => e ? 'indexed' : 'no-manifest', () => 'failed'), bound]);
    clearTimeout(timer);
    return { status: outcome, at: outcome === 'pending' ? null : new Date() };
  }

  /** Indexed entities on the parent domains or subdomains of host. */
  async _related(host, own) {
    const parents = [];
    const labels = host.split('.');
    for (let i = 1; i < labels.length - 1; i++) parents.push(labels.slice(i).join('.'));
    const under = new RegExp(`\\.${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
    const ownIds = new Set(own.map(e => String(e._id)));
    const rows = await this.db.collection('entities').find({
      type: { $in: HOSTED_TYPES },
      $or: [
        { address: { $in: parents } }, { 'metadata.domain': { $in: parents } },
        { address: under }, { 'metadata.domain': under }
      ]
    }).limit(10).toArray();
    return rows.filter(e => !ownIds.has(String(e._id)));
  }
}

function rankOf(entity) {
  return RUNG_ORDER.indexOf(rungFromSignals(entity.metadata?.signals));
}

// The origin block for a host Scan holds nothing for — the same shape
// originFacts emits, carrying only what the crawl observed.
function unindexedOrigin(probe) {
  return {
    address: null,
    rung: 'open',
    since: null,
    signature: { signed: false, verified: false, method: null },
    signals: probe.status === 'no-manifest' ? { manifest: { present: false, at: probe.at } } : {}
  };
}
