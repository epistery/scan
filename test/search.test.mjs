// Scan reports on entities with known origin. A free-form query is read for
// the entities it names; each kind has a handler; a domain answers with a
// report of what scan observes (index, .well-known, DNS, TLS); a query naming
// nothing scan holds answers with the guide to what can be searched.
//
// Needs a throwaway Mongo and the network (live DNS/TLS of michael.sprague.com):
//   MONGO=mongodb://127.0.0.1:27999 node test/search.test.mjs
import mongodb from 'mongodb';
import { readQuery } from '../search/Intent.mjs';
import HostIndex from '../search/HostIndex.mjs';
import SearchHandler from '../handlers/Search.mjs';

let failures = 0; const check = (c, m) => c ? console.log('  ok  : ' + m) : (console.log('  FAIL: ' + m), failures++);
const on = { present: true, at: new Date() };
const AGENT = '0x7ac3f3c68e502871931c21d4f5258063c2d685f7';
const HOST_WALLET = '0x76f660cDB79D6BC2b831230e5581D66a1EC9C627';

// ── reading the query ──
let i = readQuery('tourism.es');
check(i.domains.map(d => d.host).join() === 'tourism.es' && !i.addresses.length, 'a bare domain is a domain');
i = readQuery('what is on https://www.tourism.es/en/page.html today');
check(i.domains.map(d => d.host).join() === 'tourism.es', 'a URL names its host (www. dropped), not its path');
i = readQuery('Michael@Sprague.com');
check(i.domains[0]?.host === 'sprague.com' && i.domains[0].mailbox === 'michael@sprague.com' && i.domains.length === 1, 'an email names its domain and keeps the mailbox');
i = readQuery(`owner ${AGENT.toUpperCase().replace('0X', '0x')}`);
check(i.addresses.join() === AGENT && !i.domains.length, 'an address anywhere in the text is an address');
check(!readQuery('v1.2 release notes').domains.length, 'a version number is not a domain');
check(readQuery('@registry find tools').service?.name === 'registry', '@name is a service delegation');
i = readQuery('does the rain in spain fall mostly in the plain');
check(!i.domains.length && !i.addresses.length && !i.service, 'a question about the world names no entity');

// ── the index side ──
const client = await mongodb.MongoClient.connect(process.env.MONGO || 'mongodb://127.0.0.1:27999');
const db = client.db('search-test-' + Date.now());
await db.collection('entities').insertMany([
  { address: 'rootz.global', type: 'AIDiscovery', metadata: { signals: { manifest: on, dnsVerified: on }, verification: { signed: true, hashValid: true, digitalNameMatch: true }, manifest: { organization: { name: 'Rootz Corp' }, coreConcepts: [{ term: 'provenance' }] } }, _created: new Date(), _modified: new Date() },
  { address: AGENT, type: 'Agent', chain: 'polygon', metadata: { domain: 'michael.sprague.com', host: HOST_WALLET, signals: { contractExists: on, domainBinding: on } }, _created: new Date() },
  { address: 'farm:1', type: 'Object', metadata: { domain: 'x.sprague.com', object: { title: 'not a host' } } }
]);
const probed = [];
const discovery = {
  pollInterval: 86400000,
  dataSources: [{ name: 'fuel', topics: ['diesel', 'ifta'] }],
  async checkDomain(host) {
    probed.push(host);
    if (host === 'slow.test') return new Promise(r => setTimeout(() => r(null), 1500));
    await db.collection('domains').updateOne({ domain: host }, { $set: { domain: host, status: 'no-manifest', lastChecked: new Date() } }, { upsert: true });
    return null;
  }
};
const index = new HostIndex(db, discovery, { wait: 200 });
let f = await index.host('michael.sprague.com');
check(f.origin.rung === 'chain-bound' && f.probe.status === 'indexed' && probed.length === 0, 'an indexed domain agent answers with its own rung, not re-crawled');
f = await index.host('sprague.com');
check(f.origin.rung === 'open' && f.related.map(e => e.metadata?.domain).join() === 'michael.sprague.com', 'a parent of a chain-bound host is open; the subdomain is related, never inherited');
check(f.probe.status === 'no-manifest' && f.origin.signals.manifest?.present === false, 'an unpublished host reports the crawl\'s observation');
probed.length = 0;
f = await index.host('sprague.com');
check(probed.length === 0, 'a fresh no-manifest record stands without re-probing');
check((await index.host('slow.test')).probe.status === 'pending', 'a slow crawl is bounded: pending');

// ── the pipeline ──
const search = new SearchHandler({ db }, null);
search.setIngestion({ domainDiscovery: discovery });
search.reports.index.wait = 200;
const facet = (r, label) => r.card?.facets?.find(x => x.label === label)?.value;

let r = await search.search('michael.sprague.com');
let rep = r.results[0];
check(rep.type === 'DomainReport' && rep.rung === 'chain-bound' && r.results[1]?.type === 'Agent', 'a domain answers with its report, then its indexed agent as itself');
check(rep.present.facets.dns.resolves && rep.present.facets.tls.present, 'the report carries live DNS and TLS observations');
check(rep.present.facets.epistery.present && rep.present.facets.epistery.matchesAgentHost === true && /matches its domain contract/.test(facet(rep, '/.well-known/epistery')),
  'the host wallet at /.well-known/epistery is checked against the one its domain contract names');

r = await search.search('michael@sprague.com');
rep = r.results[0];
check(rep.domain === 'sprague.com' && facet(rep, 'Mailbox') === 'michael@sprague.com' && rep.rung === 'open', 'an email reports on its domain, open on its own facts');
check(r.results.some(x => x.type === 'Agent' && x.domain === 'michael.sprague.com') && /michael\.sprague\.com/.test(facet(rep, 'Related')), 'sprague.com surfaces michael.sprague.com as related');
check(facet(rep, 'MX') && facet(rep, '/.well-known/ai')?.startsWith('none found'), 'mail and manifest findings are reported as facts');

probed.length = 0;
r = await search.search('nothing.invalid');
rep = r.results[0];
check(rep.type === 'DomainReport' && /^no/.test(facet(rep, 'Resolves')) && probed.length === 0 && !facet(rep, 'TLS'), 'a name that does not resolve is reported as such — no crawl, no handshake');

r = await search.search('rootz.global');
check(r.results[1]?.type === 'AIDiscovery' && facet(r.results[0], '/.well-known/ai') === 'signed manifest, verified' && /aid1/.test(facet(r.results[0], '_ai TXT')), 'a manifest domain reports its verified manifest and _ai record');

r = await search.search('does the rain in spain fall mostly in the plain');
const g = r.meta.guide;
check(r.results.length === 0 && /not a general web search/.test(g?.note), 'a question no origin declared answers with the guide');
const ex = Object.fromEntries(g.searchable.map(s => [s.kind, s.example]));
check(ex.domain === 'rootz.global' && ex.address === AGENT && ex.text === 'diesel' && !('service' in ex), 'the guide lists only live kinds, each with an example from the index');

await db.dropDatabase();
await client.close();
console.log(failures ? `SEARCH FAIL (${failures})` : 'SEARCH PASS');
process.exit(failures ? 1 : 0);
