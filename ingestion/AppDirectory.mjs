/**
 * AppDirectory
 *
 * The directory half of an epistery identity: its NAME and the host that
 * resolves it.
 *
 * The relay writes one row per minted contract into scan's own `identities`
 * collection:
 *   { address, name, nameLower, domain, chain, owner, chatPublicKey, mintedAt }
 *
 * `domain` is the namespace the name was claimed in — the host that serves
 * `/@<name>` for it (epistery.com today, epistery.app for the older ones). It
 * is per-identity, so the link follows the row and not one configured URL.
 *
 * This module does two things with those rows and nothing else:
 *
 *   1. promotes each into the searchable `entities` collection under
 *      `metadata.app`, so a named identity is findable even when chain polling
 *      is switched off;
 *   2. registers each as a monitored IdentityContract, so the chain
 *      interpreter — the ONE owner of what an identity is — reads its devices,
 *      its sections and the sessions it offers.
 *
 * It deliberately does not fetch sessions itself. That was a second, parallel
 * reading of the same identity against one hard-coded app host; the
 * interpreter now does it per-identity against the host each one is named
 * under. See ingestion/interpreters/IdentityContractInterpreter.mjs.
 */

// A namespace scan will carry identities under: a host that can actually serve
// the identity's page to the public.
//
// This is a STRUCTURAL test and deliberately not a liveness probe. Dropping an
// identity is cancelling data, so the decision must never hinge on whether a
// host answered one HTTP request — a deploy restart would otherwise empty the
// index of real people. A host that is not publicly routable can serve nobody,
// today or ever, and that is a fact no network weather changes.
const PRIVATE_HOST = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;
function isPublicNamespace(namespace) {
  if (!namespace) return false;
  const host = String(namespace).toLowerCase().split(':')[0];
  if (PRIVATE_HOST.test(host)) return false;
  if (host.endsWith('.local') || host.endsWith('.internal')) return false;
  // A bare hostname resolves for nobody outside the network that minted it.
  return host.includes('.');
}

// chainId (as stored by the relay) → connector-map slug used elsewhere in scan.
const CHAIN_SLUGS = { 1: 'ethereum', 137: 'polygon', 80002: 'polygon-amoy', 11155111: 'sepolia', 81: 'japanopenchain' };

export default class AppDirectory {
  constructor(database, options = {}) {
    this.database = database;
    // Chains scan actually has a connector for. An identity on any other chain
    // is still indexed by name; monitoring it would only log a missing
    // connector on every poll.
    this.chains = new Set(options.chains || []);
    // Current head per chain, supplied by the ingestion manager (which owns the
    // connectors). Used to set each new monitor's event horizon — see _ensureMonitor.
    this.currentBlock = options.currentBlock || (async () => null);
    // Hosts the operator has retired. A retired host is publicly routable and
    // may still resolve in DNS, so nothing structural reveals it — it has to be
    // declared. Explicit and binary, never inferred from a failed fetch.
    this.retired = new Set((options.retiredNamespaces || []).map(d => String(d).toLowerCase()));
    this.pollInterval = options.pollInterval || 3600000; // 1 hour
    this.isRunning = false;
    this.timer = null;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[app-directory] Starting (interval: ${this.pollInterval}ms, monitoring chains: ${[...this.chains].join(', ') || 'none'})`);
    this.timer = setInterval(() => {
      this.sync().catch(e => console.error('[app-directory] sync error:', e.message));
    }, this.pollInterval);
    // Initial run
    this.sync().catch(e => console.error('[app-directory] initial sync error:', e.message));
  }

  stop() {
    this.isRunning = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /**
   * Read the relay-populated `identities` collection, index each row, and put
   * the ones on a chain we can read under chain monitoring.
   */
  async sync() {
    let rows;
    try {
      rows = await this.database.db.collection('identities').find({}).toArray();
    } catch (e) {
      console.warn('[app-directory] identities collection unreadable:', e.message);
      return { indexed: 0 };
    }

    // The set of domains a policy has marked not-listable — a domain's own
    // VISIBILITY directive, or one that has not resolved for the grace window
    // (see ingestion/DomainPolicy.mjs). Loaded once per pass so indexable()
    // stays a synchronous check, and so the same decision retires the
    // identities already written under a dark domain.
    this._unlistable = new Set(await this.database.getUnlistableDomains().catch(() => []));

    let indexed = 0;
    let monitored = 0;
    let dropped = 0;
    for (const row of rows) {
      if (!row.address) continue;
      const chain = CHAIN_SLUGS[row.chain] || row.chain || null;
      try {
        // The namespace decides whether this identity can be reached at all.
        // Checked before anything is written, and applied to what is already
        // written, so the gate and the cleanup are the same one rule.
        if (!this.indexable(row.domain)) {
          if (await this._retire(row.address, chain)) dropped++;
          continue;
        }
        const app = {
          name: row.name || null,
          nameLower: row.nameLower || (row.name ? row.name.toLowerCase() : null),
          domain: row.domain || null,
          owner: row.owner ? row.owner.toLowerCase() : null,
          publicKey: row.chatPublicKey || null,
          profileUrl: this._profileUrl(row),
          source: 'epistery-app',
          mintedAt: row.mintedAt || null,
          syncedAt: new Date()
        };

        await this.database.saveAppIdentity({ address: row.address, chain, app });
        indexed++;

        if (chain && this.chains.has(chain) && await this._ensureMonitor(row.address, chain)) monitored++;
      } catch (e) {
        console.warn(`[app-directory] failed to index ${row.address}:`, e.message);
      }
    }

    console.log(`[app-directory] Indexed ${indexed}/${rows.length} identities (${monitored} newly monitored${dropped ? `, ${dropped} dropped` : ''})`);
    return { indexed, monitored, dropped, total: rows.length };
  }

  /**
   * Whether scan will carry identities named under this host.
   *
   * An identity is findable so that someone can go to it. When the host that
   * names it cannot serve it — unroutable, or retired by its operator — the
   * result leads nowhere, and a search engine that lists it is lying about
   * what it found. The contract is untouched on chain either way.
   */
  indexable(namespace) {
    if (!isPublicNamespace(namespace)) return false;
    const host = String(namespace).toLowerCase();
    if (this.retired.has(host)) return false;
    // A domain that declared itself out (VISIBILITY) or has gone dark in DNS.
    // The fact is the domain's own, read from its contract or its absence from
    // DNS — not a list scan keeps "because we said so" (ingestion/DomainPolicy).
    if (this._unlistable?.has(host)) return false;
    return true;
  }

  /**
   * Take an identity back out of the index because its namespace can no longer
   * serve it, and stop paying RPC to watch it.
   *
   * Idempotent: once the row is gone a later pass removes nothing and says
   * nothing, so this converges rather than chattering every hour.
   */
  async _retire(address, chain) {
    const lower = address.toLowerCase();
    const removed = await this.database.removeEntity(address);
    if (chain) await this.database.deactivateMonitor(lower, chain);
    if (removed) console.log(`[app-directory] Dropped ${lower} — namespace cannot serve it`);
    return removed;
  }

  /**
   * The identity's page on the host it is named under. No name or no
   * namespace → no link; we never guess which host speaks for a contract.
   */
  _profileUrl(row) {
    if (!row.domain || !row.name) return null;
    return `https://${row.domain}/@${row.name}`;
  }

  /**
   * Put the contract under chain monitoring if it isn't already. Returns true
   * when a monitor was added, so a routine pass stays quiet.
   *
   * The new monitor's event horizon is the CURRENT block, not the default
   * hundred-thousand-block look-back. A contract's state — its devices, its
   * sections, the role each grants — is read whole on every sync from ~15 view
   * calls, so the card is complete from the first pass; the event log is the
   * separate, expensive read (one range scan per event signature per contract),
   * and backfilling days of it for every identity at once would saturate the
   * poll loop and the RPC quota for hours. So an identity's recorded history
   * starts the day scan began watching it, the horizon is stamped on the
   * monitor, and everything before it stays one click away on the explorer.
   */
  async _ensureMonitor(address, chain) {
    const lower = address.toLowerCase();
    const existing = await this.database.monitors.findOne({ address: lower, chain });
    if (existing) return false;
    const fromBlock = await this.currentBlock(chain).catch(() => null);
    await this.database.addMonitor({
      address: lower,
      chain,
      type: 'IdentityContract',
      active: true,
      metadata: { addedAt: new Date(), via: 'app-directory', ...(fromBlock ? { fromBlock } : {}) }
    });
    console.log(`[app-directory] Monitoring IdentityContract ${lower} on ${chain}`);
    return true;
  }
}
