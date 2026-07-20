/**
 * Present — projects a stored entity into the fixed `present.ai` contract.
 *
 * This is the stable, agent-facing shape. Per-source data stays loose in the
 * stored entity (metadata.object = indexed digest, metadata.fields = the raw
 * author body, metadata.source = provenance). This projection wraps that loose
 * data in ONE rigid envelope an AI client can bind to once and rely on for
 * every result of every type — the opposite discipline from the data, which is
 * deliberately loose.
 *
 * Hard rule, the registry's reason for existing: Scan reports FACTS with known
 * origin, never a verdict. There is deliberately no trustScore here — only the
 * signals and derived facts a surface (e.g. the GUI) could use to build one.
 * Every derived fact (age, rung) is a cache of an observed origin event; we may
 * hold it in memory, we never forget where it came from.
 */

import { summarizeSignals } from './Posture.mjs';

/**
 * Identity continuity ladder, derived from signed posture signals.
 * A rung is only claimed when the signals PROVE it — we never overclaim.
 * 'legal-entity' (a key bound to a registered entity / DBA multisig / tax id)
 * is reserved for a future binding signal; today's signals top out at an
 * on-chain identity bound to its own domain.
 */
export function rungFromSignals(signals = {}) {
  const on = (name) => !!signals?.[name]?.present;
  if (on('contractExists') && on('domainBinding')) return 'chain-bound';
  if (on('dnsVerified') || on('domainBinding'))     return 'dns';
  if (on('selfSigned'))                              return 'claimed';
  return 'open';
}

/**
 * The origin packet: who signed this and the continuity that can harbor a
 * reputation — as facts, not a score. `since` is age derived from the first
 * event Scan observed. `claims` (history depth) is a batched per-origin count
 * supplied by enrichment when available — never a faked zero.
 */
export function originFacts(entity) {
  const m = entity.metadata || {};
  const sig = m.verification || m.signature || {};
  const facts = {
    address: m.source?.author
      || sig.digitalName
      || m.manifest?._signature?.digitalName
      || entity.metadata?.app?.owner
      || null,
    rung: rungFromSignals(m.signals),
    since: entity._created || null,            // derived: first known event
    signature: {
      signed:   !!(sig.signed || sig.hashValid),
      verified: !!(sig.hashValid && sig.digitalNameMatch),
      method:   sig.method || m.manifest?._signature?.method || null,
    },
    // Raw, verifiable facts. A surface may construct a score from these; Scan does not.
    signals: summarizeSignals(m.signals),
  };
  if (entity._originClaims != null) facts.claims = entity._originClaims;  // batched enrichment
  return facts;
}

/**
 * The pull-on-hit handle. The agent fetches this and verifies the origin's
 * signature itself — Scan hands over the locator, it does not proxy the body.
 */
export function locatorFor(entity) {
  const m = entity.metadata || {};
  const yields = m.object?.type || (entity.type === 'AIDiscovery' ? 'organization' : entity.type) || 'object';
  const objUrl = m.fields?.url || m.fields?.link || m.fields?.href;
  if (objUrl)            return { fetch: objUrl,        kind: 'signed-json', yields };
  if (m.source?.url)     return { fetch: m.source.url,  kind: 'signed-json', yields };
  // Contract-backed digests: the locator is the chain itself (explorer URL) —
  // the stored figures are a cache; the contract is the origin.
  if (m.object?.jsonld?.url) return { fetch: m.object.jsonld.url, kind: 'chain', yields };
  if (m.app?.profileUrl) return { fetch: m.app.profileUrl, kind: 'signed-json', yields: 'identity' };
  if (entity.type === 'AIDiscovery' && entity.address) {
    return { fetch: `https://${entity.address}/.well-known/ai`, kind: 'manifest', yields: 'organization' };
  }
  return null;
}

/**
 * Affordances beyond read — advertised, never brokered. Each resolves to the
 * origin's own endpoint, invoked with the user's epistery identity. `needs` is
 * the identity rung the action requires (default 'none').
 */
export function actionsFor(entity) {
  const m = entity.metadata || {};
  const actions = [];

  // Two capability shapes exist in the wild: scan's own array of
  // {name, endpoint, ...} and the AI-Discovery manifest's object map
  // {name: {available, url, auth}}. Iterating the map as an array threw
  // ("caps is not iterable") and blanked every text-search result set that
  // included such an entity — normalize both shapes instead.
  const raw = m.capabilities || m.manifest?.capabilities || [];
  const caps = Array.isArray(raw)
    ? raw
    : Object.entries(raw).map(([name, v]) =>
        (v && typeof v === 'object') ? { name, ...v } : { name, available: !!v });

  // Manifest endpoints are declared relative to the manifest's own domain.
  const domain = entity.type === 'AIDiscovery' ? entity.address : (m.domain || null);
  const absolute = (url) => (typeof url === 'string' && url.startsWith('/') && domain)
    ? `https://${domain}${url}` : url;

  for (const cap of caps) {
    const endpoint = cap?.endpoint || cap?.url;
    if (!endpoint || cap.available === false) continue;
    const action = { name: cap.name || 'query', invoke: absolute(endpoint), needs: cap.needs || 'none' };
    if (cap.auth && cap.auth !== 'none') action.auth = cap.auth;
    actions.push(action);
  }
  // Contract-backed digests may carry the owner's own serving routes (a
  // campaign's factory /render, /link, /status — see CampaignWalletInterpreter).
  // Advertised as invocable endpoints; note `render` records a served view on
  // the campaign when fetched.
  const loc = m.object?.jsonld?.locators;
  if (loc) {
    if (loc.render) actions.push({ name: 'render', invoke: loc.render, needs: 'none' });
    if (loc.link)   actions.push({ name: 'click',  invoke: loc.link,   needs: 'none' });
    if (loc.status) actions.push({ name: 'status', invoke: loc.status, needs: 'none' });
  }
  return actions;
}

/**
 * Some result types are live/directory entries, not stored signed entities:
 * Skill (a source's tool manifest), MCPService (a federated MCP registry entry),
 * Wallet/Contract (live chain reads), CapabilityProxy (a source endpoint match).
 * They get the SAME fixed envelope so an agent binds once to every result — in
 * directory mode: a `locator` + `actions` the agent pulls and verifies itself.
 *
 * Anything Scan fetched on the agent's behalf (a skill prefetch, a proxied body)
 * is surfaced under `brokered` and nothing else — because Scan stood in the path,
 * so the origin signature was never verified end-to-end. It is second-class by
 * construction; the `locator` is always offered alongside so the agent can bypass
 * Scan and pull the origin directly.
 */
const BROKERED_NOTE =
  'fetched by scan, not verified end-to-end against the origin signature — pull locator to verify directly';

function liveOrigin(r) {
  const isChain = r.type === 'Wallet' || r.type === 'Contract';
  return {
    address: r.author || r.domain || (isChain ? r.name : null) || null,
    rung: 'open',                       // live/unsigned; chain reads are re-readable, not author-signed
    since: null,
    signature: {
      signed:   !!r.signature?.signed,
      verified: !!r.signature?.verified,
      method:   r.signature?.method || null,
    },
    signals: {},
  };
}

function liveLocator(r) {
  switch (r.type) {
    case 'MCPService':
      return r.mcpService?.detail_url
        ? { fetch: r.mcpService.detail_url, kind: 'mcp', yields: 'tools' } : null;
    case 'Skill': {
      const fetch = r.mcp_endpoint || r.api_base || (r.domain ? `https://${r.domain}` : null);
      return fetch ? { fetch, kind: r.mcp_endpoint ? 'mcp' : 'api', yields: 'tools' } : null;
    }
    case 'CapabilityProxy':
      return r.endpoint ? { fetch: r.endpoint, kind: 'api', yields: 'results' } : null;
    case 'Wallet':
    case 'Contract':
      return r.name
        ? { fetch: r.name, kind: 'chain', yields: r.isContract ? 'contract' : 'wallet', chain: r.chain || null }
        : null;
    default:
      return null;
  }
}

function liveActions(r) {
  const actions = [];
  if (r.type === 'Skill') {
    const base = r.api_base || (r.domain ? `https://${r.domain}` : '');
    for (const t of (r.tools || [])) {
      actions.push({
        name: t.name,
        invoke: t.path ? `${base}${t.path}` : (t.path || null),
        method: t.method || 'GET',
        needs: 'none',
      });
    }
  } else if (r.type === 'MCPService' && r.mcpService?.detail_url) {
    actions.push({ name: 'list_tools', invoke: r.mcpService.detail_url, needs: 'none' });
  } else if (r.type === 'CapabilityProxy' && r.endpoint) {
    actions.push({ name: r.capability || 'query', invoke: r.endpoint, needs: 'none' });
  }
  return actions;
}

export function presentForLiveResult(r) {
  const present = {
    type:     r.objectType || r.type || null,
    headline: r.name || r.domain || null,
    summary:  r.mission || null,
    origin:   liveOrigin(r),
    freshness: { observed: r.lastChecked || null, live: [] },
    locator:  liveLocator(r),
    facets:   null,
    actions:  liveActions(r),
  };
  const brokered = r.initialResults !== undefined ? r.initialResults
                 : r.proxyData !== undefined ? r.proxyData
                 : undefined;
  if (brokered !== undefined) present.brokered = { note: BROKERED_NOTE, data: brokered };
  return present;
}

/**
 * Project a stored entity into the fixed present.ai envelope.
 */
export function toPresentAi(entity) {
  const m = entity.metadata || {};
  const obj = m.object || {};
  const type = obj.type || (entity.type === 'AIDiscovery' ? 'organization' : entity.type) || null;

  return {
    type,
    schema: obj.schema || null,   // public schema IRI — the map at /api/schema/{label} declares its projection
    headline: obj.title || m.manifest?.organization?.name || m.app?.name || entity.address || null,
    summary:  obj.summary || m.manifest?.organization?.mission || m.app?.description || null,
    origin:   originFacts(entity),
    freshness: {
      observed: entity._modified || entity._created || null,
      // Fields whose stored value is a hint — pull the locator to trust them.
      // Declared per-interpreter on metadata.object.volatile; [] until then.
      live: m.object?.volatile || [],
    },
    locator: locatorFor(entity),
    // The loose body: the author's verbatim object, or — for contract-backed
    // entities with no fields — the chain-state projection (itself a cache of
    // facts anyone can re-read at the locator).
    facets:  m.fields || m.object?.jsonld || null,
    actions: actionsFor(entity),
  };
}
