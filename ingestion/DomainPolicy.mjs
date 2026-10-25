import { probeDns } from '../search/probes/dns.mjs';

/**
 * DomainPolicy
 *
 * The one owner of a single question: *may scan list this domain, and is it
 * still there to be listed?* Two independent reasons answer no, and both are
 * the domain's own fact — never scan's opinion of it:
 *
 *   1. VISIBILITY — a domain controls its presence through its own DomainContract.
 *      A DomainContract is an {EpisteryAccess}, so it carries open public name/value
 *      attributes in its `_profile` section (getPublicKeys/getPublic). A webmaster
 *      who does not want to be found writes one — `VISIBILITY=NONE` — and scan honours
 *      it. This is NOT a hard-coded denylist: the instruction lives on chain, signed
 *      by the domain's rivets, and scan merely reads and obeys it. Every attribute is
 *      recorded in `directives`, so a new ad-hoc flag a domain invents is captured the
 *      moment it appears — it simply does nothing until scan learns to act on it.
 *
 *   2. STALENESS — a result that points at a domain which no longer exists is a
 *      lie about what scan found. So a domain that has not resolved in DNS *for
 *      some time* is cleaned out. "For some time" is the whole of it: we never
 *      drop on one failed lookup, and never on network weather (a SERVFAIL or a
 *      timeout is "don't know", not "gone"). Only a clean, repeated NXDOMAIN past
 *      a grace window delists. This mirrors the deliberate caution in
 *      {AppDirectory} — dropping data must not hinge on one bad moment.
 *
 * The domain→contract link is DNS: a TXT record at `_epistery.<domain>` whose
 * value is the contract address (the convention DomainContract is bound by). A
 * domain that publishes none has no directive we can read and is listable by
 * default — absence of an instruction is not an instruction.
 *
 * FAIL SAFE FOR AVAILABILITY. A dead RPC or an unreadable contract returns
 * UNKNOWN, never "suppress": a provider hiccup must not delist real domains. A
 * domain goes dark ONLY on a *successful* read of a suppress value, or on
 * sustained non-resolution. The verdict is written to the `domains` record;
 * {AppDirectory} consults it to drop the identities named under a dark domain
 * (its one careful `_retire`), and the domain's own AIDiscovery result is
 * removed here. The contract is untouched on chain either way.
 */

const PROFILE_SECTION = '_profile';

// A DomainContract read as narrowly as this policy needs: the domain it names
// (to confirm the DNS binding points at the right contract) and its `_profile`
// public attributes (the directives). It is an IdentityContract/EpisteryAccess,
// but scan does not import the app — it reads the chain through this slice.
const DOMAIN_ABI = [
  'function domain() view returns (string)',
  'function getPublicKeys(string) view returns (string[])',
  'function getPublic(string, string) view returns (string)'
];

// VISIBILITY values that read as "do not list me". Fuzzy on purpose: a webmaster
// writes the intent, not a token from a spec — NONE, no, off, hidden, private all
// mean the same thing. Anything else (and an unset attribute) leaves the domain
// listable. Compared lowercased and trimmed.
const SUPPRESS = new Set(['none', 'no', 'off', 'false', '0', 'hidden', 'private', 'never', 'noindex', 'nolist']);

const DAY = 86400000;

// ── pure helpers (exported for tests; no DB, no chain, no clock of their own) ──

/**
 * Read a domain's public attributes as scan directives. Today only VISIBILITY
 * is acted on; the whole map is returned so nothing a domain declares is lost.
 * Key and value are matched case-insensitively.
 */
export function interpretVisibility(attributes) {
  const attrs = attributes || {};
  let visibility = null;
  for (const [k, v] of Object.entries(attrs)) {
    if (String(k).trim().toLowerCase() === 'visibility') { visibility = v; break; }
  }
  const suppressed = visibility != null && SUPPRESS.has(String(visibility).trim().toLowerCase());
  return { visibility: visibility ?? null, listable: !suppressed };
}

/**
 * Advance, hold, or clear the DNS-unresolved clock from one probe.
 *   - a positive answer (addresses) clears it — the domain is alive;
 *   - a clean negative (resolves=false AND no transport error: NXDOMAIN/ENODATA)
 *     starts it, or leaves an already-running clock where it is;
 *   - a transient failure (error set: SERVFAIL/timeout) is "don't know" — the
 *     clock is left exactly as it was, so network weather never ages a domain out.
 */
export function nextUnresolved(prevSince, dnsResult, now) {
  if (dnsResult.resolves) return null;
  if (dnsResult.error) return prevSince || null;
  return prevSince || now;
}

/** Has the unresolved clock run past the grace window? */
export function staleExpired(unresolvedSince, now, graceMs) {
  if (!unresolvedSince) return false;
  return (now.getTime() - new Date(unresolvedSince).getTime()) >= graceMs;
}

export default class DomainPolicy {
  constructor(database, connectors = {}, options = {}) {
    this.database = database;
    this.connectors = connectors;
    // DomainContracts live on Polygon today. Prefer it; otherwise read through
    // the first connector scan has. No connector → directives are simply unknown
    // and nothing is suppressed on that ground (DNS staleness still applies).
    this.chain = options.chain || (connectors.polygon ? 'polygon' : Object.keys(connectors)[0] || null);
    this.graceMs = options.graceMs || 30 * DAY;
    this.pollInterval = options.pollInterval || 6 * 3600000; // 6 hours
    this.isRunning = false;
    this.timer = null;
  }

  _connector() { return this.chain ? this.connectors[this.chain] : null; }

  /**
   * The DomainContract address a domain publishes in DNS, or null.
   *
   * Primary: a TXT record at `_epistery.<domain>` carrying the bare address (the
   * underscore name is never a hostname, so it cannot collide with a verifier's
   * TXT). Fallback: a legacy `epistery=0x…` line at the apex. We read an address
   * out of whichever answers; a domain with neither has no contract we can read.
   */
  async contractAddress(domain) {
    const addrIn = (s) => { const m = String(s).match(/0x[0-9a-fA-F]{40}/); return m ? m[0].toLowerCase() : null; };
    try {
      const rec = await this._resolveTxt(`_epistery.${domain}`);
      for (const r of rec) { const a = addrIn(Array.isArray(r) ? r.join('') : r); if (a) return a; }
    } catch { /* no _epistery record — fall through */ }
    try {
      const rec = await this._resolveTxt(domain);
      // Only an explicit epistery= line at the apex, so a wildcard SPF/parking
      // record is never misread as an address.
      const line = rec.map(r => (Array.isArray(r) ? r.join('') : r)).find(t => /^epistery=/i.test(t));
      if (line) { const a = addrIn(line); if (a) return a; }
    } catch { /* none */ }
    return null;
  }

  // Split out so a test can stub DNS without a network. Uses Node's resolver via
  // the shared probe module's dependency surface indirectly — here, the plain API.
  async _resolveTxt(name) {
    const dns = await import('dns');
    return await dns.promises.resolveTxt(name);
  }

  /**
   * A domain's DomainContract directives, or null for UNKNOWN. Null — never a
   * suppress — when there is no connector, no published contract, the contract's
   * `domain()` does not match (not this domain's contract), or the read fails.
   */
  async readDirectives(domain) {
    const connector = this._connector();
    if (!connector) return null;
    const address = await this.contractAddress(domain);
    if (!address) return null;
    try {
      const contract = connector.getContract(address, DOMAIN_ABI);
      const declared = await contract.domain();
      if (!declared || String(declared).trim().toLowerCase() !== String(domain).toLowerCase()) return null;
      const keys = await contract.getPublicKeys(PROFILE_SECTION);
      const attributes = {};
      for (const k of (keys || [])) {
        try { attributes[k] = await contract.getPublic(PROFILE_SECTION, k); } catch { /* skip one unreadable key */ }
      }
      return { address, attributes };
    } catch {
      return null; // UNKNOWN — the chain couldn't be read this pass.
    }
  }

  /**
   * The verdict for one domain, given its previous `domains` record. Carries the
   * last-known directives forward when this pass could not read the chain, so a
   * transient RPC failure neither invents a directive nor forgets a real one.
   */
  async assess(domain, prev = {}) {
    const now = new Date();
    const dnsResult = await probeDns(domain);
    const unresolvedSince = nextUnresolved(prev.unresolvedSince, dnsResult, now);
    const stale = staleExpired(unresolvedSince, now, this.graceMs);

    const read = await this.readDirectives(domain);
    const directives = read ? read.attributes : (prev.directives || null);
    const contract = read ? read.address : (prev.contract || null);
    const { visibility, listable: visListable } = interpretVisibility(directives);

    let listable = true, reason = 'listed';
    if (!visListable) { listable = false; reason = 'visibility'; }
    else if (stale)   { listable = false; reason = 'unresolved'; }

    return {
      domain, contract, directives, visibility,
      // keep last-known resolve state across a transient "don't know"
      resolves: dnsResult.error ? (prev.resolves ?? null) : dnsResult.resolves,
      unresolvedSince, listable, reason, policyAt: now
    };
  }

  /**
   * Every domain scan might list: crawl-state rows, discovered AIDiscovery
   * results, and the namespaces named identities live under. The last of these
   * is why a domain like a private dev host gets policed even though it was
   * never an AI-discovery crawl target.
   */
  async domainSet() {
    const set = new Set();
    try { for (const d of await this.database.getAllDomains()) if (d.domain) set.add(String(d.domain).toLowerCase()); }
    catch (e) { console.warn('[domain-policy] domains collection unreadable:', e.message); }
    try {
      const rows = await this.database.entities.find(
        { $or: [{ type: 'AIDiscovery' }, { 'metadata.app.domain': { $exists: true, $ne: null } }] },
        { projection: { address: 1, type: 1, 'metadata.app.domain': 1 } }
      ).toArray();
      for (const r of rows) {
        if (r.type === 'AIDiscovery' && r.address) set.add(String(r.address).toLowerCase());
        const ns = r.metadata?.app?.domain; if (ns) set.add(String(ns).toLowerCase());
      }
    } catch (e) { console.warn('[domain-policy] entities unreadable for domain set:', e.message); }
    // A bare hostname resolves for nobody; localhost/loopback is not a public domain.
    return [...set].filter(d => d.includes('.') && !/^(localhost|127\.|0\.0\.0\.0|\[?::1\]?)/.test(d));
  }

  /**
   * One pass: assess each domain, write its verdict, and on a fresh transition
   * to dark remove the domain's own AIDiscovery result and log it once. The
   * identities named under it drop on {AppDirectory}'s next pass, which already
   * owns that removal. Converges — a domain already dark produces no further
   * writes and no further noise.
   */
  async sweep() {
    const domains = await this.domainSet();
    let suppressed = 0, retired = 0, restored = 0;
    for (const domain of domains) {
      try {
        const prev = (await this.database.getDomain(domain)) || {};
        const v = await this.assess(domain, prev);
        const wasListable = prev.listable !== false; // default (unset) = listable
        await this.database.updateDomain(domain, {
          contract: v.contract, directives: v.directives, visibility: v.visibility,
          resolves: v.resolves, unresolvedSince: v.unresolvedSince,
          listable: v.listable, listReason: v.reason, policyAt: v.policyAt
        });
        if (!v.listable && wasListable) {
          if (await this.database.removeEntity(domain)) retired++;
          await this.database.recordEvent({
            source: 'policy', entityId: domain, type: `policy.${v.reason}`,
            data: { domain, reason: v.reason, visibility: v.visibility, contract: v.contract }
          });
          suppressed++;
          console.log(`[domain-policy] ${domain} delisted (${v.reason})`);
        } else if (v.listable && !wasListable) {
          restored++;
          console.log(`[domain-policy] ${domain} relisted`);
        }
      } catch (e) {
        console.warn(`[domain-policy] assess failed for ${domain}: ${e.message}`);
      }
    }
    console.log(`[domain-policy] Swept ${domains.length} domains (${suppressed} delisted, ${retired} results removed, ${restored} relisted)`);
    return { total: domains.length, suppressed, retired, restored };
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[domain-policy] Starting (interval: ${this.pollInterval}ms, grace: ${Math.round(this.graceMs / DAY)}d, chain: ${this.chain || 'none'})`);
    this.timer = setInterval(() => {
      this.sweep().catch(e => console.error('[domain-policy] sweep error:', e.message));
    }, this.pollInterval);
    this.sweep().catch(e => console.error('[domain-policy] initial sweep error:', e.message));
  }

  stop() {
    this.isRunning = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
