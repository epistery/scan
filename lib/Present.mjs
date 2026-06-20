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
  const caps = m.capabilities || m.manifest?.capabilities || [];
  const actions = [];
  for (const cap of caps) {
    if (cap?.endpoint) {
      actions.push({ name: cap.name || 'query', invoke: cap.endpoint, needs: cap.needs || 'none' });
    }
  }
  return actions;
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
    facets:  m.fields || null,          // the loose, author-verbatim body
    actions: actionsFor(entity),
  };
}
