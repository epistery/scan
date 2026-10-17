/**
 * Intent — what a free-form query is asking about.
 *
 * Scan reports on entities with known origin; it is not a general web search.
 * So the first step of every search is to find the entities named in the
 * query, however they were typed: a chain address, a domain, a URL (its host),
 * an email address (its domain), anywhere in the text. "what is tourism.es"
 * and "https://www.tourism.es/en" both name tourism.es.
 *
 * The reading is deliberately loose — a token that only looks like a domain is
 * still handed to the domain handler, whose report says plainly whether it
 * resolves. A query naming no entity is free text, for the index's text search.
 */

const ADDRESS = /\b0x[a-f0-9]{40}\b/gi;
const URL_HOST = /\bhttps?:\/\/([^\s/:?#]+)\S*/gi;   // the whole URL, so its path is not read as a domain
const EMAIL = /\b([a-z0-9._%+-]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/gi;
// labels of letters/digits/hyphens, ending in an alphabetic label of 2+ — so a
// version number (v1.2) or a decimal is not a domain
const DOMAIN = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}\b/gi;

function normalizeHost(host) {
  return host.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

export function readQuery(query) {
  const raw = String(query || '').trim();
  const intent = { raw, service: null, addresses: [], domains: [] };

  // Explicit MCP delegation: @service-name <query> — the whole query is for it
  const svc = raw.match(/^@(\S+)\s*(.*)/);
  if (svc && !svc[1].includes('@')) {
    intent.service = { name: svc[1], query: svc[2].trim() };
    return intent;
  }

  let rest = raw;
  const take = (re, fn) => { rest = rest.replace(re, (...m) => { fn(m); return ' '; }); };
  const seen = new Set();
  const addDomain = (host, from, extra = {}) => {
    const h = normalizeHost(host);
    if (seen.has(h)) return;
    seen.add(h);
    intent.domains.push({ host: h, from, ...extra });
  };

  take(ADDRESS, m => intent.addresses.push(m[0].toLowerCase()));
  take(URL_HOST, m => addDomain(m[1], 'url'));
  take(EMAIL, m => addDomain(m[2], 'email', { mailbox: `${m[1]}@${m[2]}`.toLowerCase() }));
  take(DOMAIN, m => addDomain(m[0], 'domain'));
  intent.addresses = [...new Set(intent.addresses)];
  return intent;
}

/** True when the query names an entity a dedicated handler reports on. */
export function namesEntities(intent) {
  return intent.addresses.length > 0 || intent.domains.length > 0;
}
