/**
 * DomainQuery — a query naming a domain (typed, in a URL, or in an email
 * address) answers with that domain's report, then the indexed entities on it,
 * its parent and its subdomains as themselves.
 *
 * The report row is facts with a time: the observations live under
 * present.facets verbatim for an agent, and the card facets are their
 * one-line reading for a person — computed here, once, for both.
 */
import { rungFromSignals } from '../lib/Present.mjs';

const short = (a) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';
const day = (d) => d ? new Date(d).toISOString().slice(0, 10) : '';

function wellKnownAi(index) {
  const manifest = index.entities.find(e => e.type === 'AIDiscovery');
  if (manifest) {
    const sig = manifest.metadata?.verification || {};
    return sig.hashValid && sig.digitalNameMatch ? 'signed manifest, verified'
      : sig.signed ? 'signed manifest, not verified' : 'manifest, unsigned';
  }
  switch (index.probe.status) {
    case 'no-manifest': return `none found · checked ${day(index.probe.at)}`;
    case 'pending': return 'checking…';
    case 'failed': return 'check failed';
    default: return 'not checked';
  }
}

function facetsOf({ index, dns, tls, epistery }, target) {
  const f = [];
  const add = (label, value) => { if (value) f.push({ label, value }); };
  if (target.mailbox) add('Mailbox', target.mailbox);
  add('Index', index.entities.length
    ? index.entities.map(e => `${e.type} (${rungFromSignals(e.metadata?.signals)})`).join(', ')
    : 'not indexed');
  add('Related', index.related.map(e => e.metadata?.domain || e.address).join(', '));
  add('Resolves', dns.resolves ? dns.addresses.slice(0, 3).join(', ') : `no${dns.error ? ` (${dns.error})` : ''}`);
  if (!dns.resolves) return f;
  add('/.well-known/ai', wellKnownAi(index));
  add('/.well-known/epistery', epistery.present
    ? `host wallet ${short(epistery.wallet)}${epistery.matchesAgentHost === true ? ' · matches its domain contract'
      : epistery.matchesAgentHost === false ? ' · differs from its domain contract' : ''}`
    : 'none');
  add('_ai TXT', dns.ai || 'none');
  add('TLS', tls.present
    ? `${tls.issuer || 'unknown issuer'} · until ${day(tls.validTo)}${tls.valid ? '' : ` · invalid (${tls.error})`}`
    : `none${tls.error ? ` (${tls.error})` : ''}`);
  add('Certificate org', tls.organization);
  add('MX', dns.mx ? dns.mx.join(', ') : 'none');
  add('SPF', dns.spf || 'none');
  add('DMARC', dns.dmarc ? (dns.dmarc.match(/\bp=([a-z]+)/i)?.[1] || dns.dmarc) : 'none');
  add('CAA', dns.caa ? dns.caa.join(', ') : 'none');
  add('NS', dns.ns ? dns.ns.join(', ') : null);
  return f;
}

function toResult(report, target) {
  const { host, index, dns, tls, epistery } = report;
  return {
    type: 'DomainReport',
    name: host,
    domain: host,
    url: `https://${host}`,
    rung: index.origin.rung,
    signals: index.origin.signals,
    probe: index.probe,
    card: { image: null, facets: facetsOf(report, target) },
    source: 'scan-observed',
    lastChecked: dns.at,
    present: {
      type: 'domain',
      schema: null,
      headline: host,
      summary: null,
      origin: index.origin,
      freshness: { observed: dns.at, live: [] },
      locator: { fetch: `https://${host}/.well-known/ai`, kind: 'manifest', yields: 'organization' },
      facets: { index: { indexed: index.entities.length > 0, crawl: index.probe }, dns, tls, epistery },
      actions: []
    }
  };
}

export default {
  kind: 'domain',
  describe: 'A domain, URL or email address — what scan indexes for it, its /.well-known/ai and /.well-known/epistery, its DNS records and TLS certificate',
  targets: (intent) => intent.domains,

  async run(target, scan, out) {
    const report = await scan.reports.report(target.host);
    out.results.push(toResult(report, target));
    const shown = new Set(out.results.map(r => r.address).filter(Boolean));
    const entities = [...report.index.entities, ...report.index.related].filter(e => !shown.has(e.address));
    out.results.push(...(await scan._formatEntities(entities)));
    if (report.index.probe.status === 'pending') {
      out.meta.discovering = target.host;
      out.meta.message = `Checking ${target.host} for /.well-known/ai manifest...`;
    }
  },

  async example(scan) {
    const e = await scan.db.collection('entities')
      .findOne({ type: 'AIDiscovery' }, { sort: { _modified: -1 }, projection: { address: 1 } });
    return e?.address || null;
  }
};
