import express from 'express';
import { reviewPipeline, ALLOWED_STAGES, FORBIDDEN_OPERATORS, LIMITS } from '../lib/SafeAggregate.mjs';
import { toPresentAi, stampOriginClaims } from '../lib/Present.mjs';
import { signResponse } from '../lib/sign.mjs';

/**
 * QueryHandler — a bot-facing MongoDB aggregation surface over scan's index.
 *
 * The charter's stated next step (wiki EpisteryScan): "the answer is a query
 * surface over the declared fields and origin facts." Text search finds what an
 * author titled; an aggregation lets a caller ask the index its own question —
 * find the campaigns in a sector, the dealerships in a region, the sources with
 * a given rung — and impose its OWN ordering (wiki NoArbiter: scan renders no
 * verdict, so its query language must be expressive enough for callers to rank
 * for themselves).
 *
 * Three tenets shape it:
 *   - PullOnHit: results are the index, not an archive. A row that is a whole
 *     entity is projected through the present.ai envelope, which carries the
 *     LOCATOR to the live signed origin and the ORIGIN FACTS — the caller pulls
 *     and verifies the origin itself. Scan does not re-serve the body.
 *   - ClientDoesTheCompute: the aggregation is the only work scan does; the
 *     caller spends its own tokens and gas pulling and verifying each hit.
 *   - NoArbiter: the pipeline's own output shape is the caller's; scan attaches
 *     origin facts where it can and editorializes nothing.
 *
 * Safety is wholly owned by lib/SafeAggregate.mjs (read-only, single collection,
 * no code execution, bounded). This handler runs the reviewed pipeline under the
 * resource bounds that review returned and projects the rows. v1 is free and
 * unmetered; a per-query toll and the identity it is drawn on are a later change
 * set (the existing resold-service meter), gated on whether real usage shows the
 * surface is worth pricing.
 *
 * The one collection queried is `entities` — scan's public catalog of the signed
 * web (signed domains, app identities, imported signed objects, on-chain
 * contracts). It holds declared facts and observed signals, never secrets (wiki
 * FactsNotSecrets), so the query is a read over public data.
 */
// The entity fields that carry the domain a row is "under". A row is pruned when
// ANY of these, lowercased, is a delisted/retired namespace — AIDiscovery stores
// the domain as its `address`; imported objects and app identities carry it in
// metadata. Lowercased comparison matches the owner's own gate
// (ingestion/AppDirectory.mjs indexable(): String(namespace).toLowerCase()).
const DOMAIN_FIELDS = ['$address', '$metadata.domain', '$metadata.source.domain', '$metadata.app.domain'];

/**
 * The policy gate as an aggregation $match: drop every row whose domain is in the
 * excluded set. Built as an $expr so each field is lowercased before the check —
 * the same decision AppDirectory makes per row, expressed for Mongo. Returns null
 * when nothing is excluded (no gate stage is then prepended).
 */
export function buildDomainExclusionScope(excluded) {
  const E = [...new Set((excluded || []).map(d => String(d).toLowerCase()).filter(Boolean))];
  if (E.length === 0) return null;
  return {
    $expr: {
      $and: DOMAIN_FIELDS.map(path => ({
        $not: [{ $in: [{ $toLower: { $ifNull: [path, ''] } }, E] }],
      })),
    },
  };
}

export default class QueryHandler {
  constructor(connector, database) {
    this.connector = connector;
    this.db = connector.db;
    // The Database wrapper owns getUnlistableDomains() — the authoritative
    // delist set (visibility-out + stale/unreachable, see ingestion/DomainPolicy).
    this.database = database;
    this.ingestion = null;
  }

  setIngestion(ingestion) {
    this.ingestion = ingestion;
  }

  // The domains a query must not surface — the SAME decision the rest of scan's
  // read path honors, read live so a just-delisted domain drops at once: the
  // DomainPolicy not-listable set, plus the operator's manually retired
  // namespaces (ingestion/AppDirectory holds that config set). This is the service,
  // not a back door, so it refuses the identical set to /api/search. Throws on a
  // read failure; the caller fails CLOSED rather than serve an unfiltered result.
  async excludedDomains() {
    const unlistable = await this.database.getUnlistableDomains();   // throws → fail closed
    const retired = this.ingestion?.appDirectory?.retired;
    return [...unlistable, ...(retired ? [...retired] : [])];
  }

  // The manual, not a card (wiki ReadmeIsTheManual): a cold bot reads this and
  // has the executable recipe — the endpoint, the shape, the limits, the stages
  // it may use, and a worked example — without reverse-engineering anything.
  usage(req) {
    const origin = `${req.protocol}://${req.get('host')}`;
    return {
      service: 'epistery-scan query',
      summary: 'Run a read-only MongoDB aggregation pipeline over the signed-web index and get back results with their origin facts.',
      collection: 'entities',
      how: {
        GET: `${origin}/api/query?pipeline=<url-encoded JSON array>&limit=50`,
        POST: `${origin}/api/query  with JSON body { "pipeline": [ ...stages ], "limit": 50 }`,
        accept: 'application/json',
      },
      rules: {
        readOnly: 'The pipeline may only read. Writes, code execution, cross-collection joins, and server introspection are refused.',
        allowedStages: [...ALLOWED_STAGES],
        refusedOperators: [...FORBIDDEN_OPERATORS],
        limits: {
          maxStages: LIMITS.MAX_STAGES,
          maxResults: LIMITS.MAX_LIMIT,
          defaultResults: LIMITS.DEFAULT_LIMIT,
          maxTimeMS: LIMITS.MAX_TIME_MS,
        },
      },
      fields: {
        note: 'Each document is an indexed entity. Common fields to match and group on:',
        type: 'one of AIDiscovery (a signed domain), AppIdentity, Object (an imported signed object — campaign, vehicle, fuel price, …), or an on-chain type (IdentityContract, CampaignWallet, Contract, Wallet).',
        address: 'the entity address or source-prefixed object id (lowercased).',
        chain: 'the chain slug for on-chain entities.',
        'metadata.object.type': 'the declared object type (e.g. Campaign, Vehicle, GasStation).',
        'metadata.object.schema': 'the public schema IRI; its map is at /api/schema/{name}.',
        'metadata.source.name': 'the data source an imported object came from.',
        'metadata.source.domain': 'the publishing domain.',
        'metadata.signals': 'observed posture signals (contractExists, domainBinding, dnsVerified, selfSigned), each { present, at }.',
      },
      results: {
        shape: 'Rows come back as your pipeline shaped them. A row that is a whole entity also carries `present` — the fixed present.ai envelope with the locator to the live signed origin and the origin facts (schema at /api/schema). Pull the locator and verify the origin yourself (PullOnHit).',
        visibility: 'This is the same index the public search serves, held to the same policy: a domain that has delisted itself (its own VISIBILITY directive) or gone dark is pruned BEFORE your pipeline runs, so it never appears in a row or a $group count. This query surface is the service, not a back door around that.',
      },
      example: {
        description: 'Ad campaigns, newest first, with their origin facts.',
        pipeline: [
          { $match: { 'metadata.object.type': 'Campaign' } },
          { $sort: { _modified: -1 } },
          { $limit: 10 },
        ],
      },
      pricing: 'Free and unmetered during evaluation. A flat per-query toll drawn on a presented identity is planned once usage shows the surface is worth pricing.',
    };
  }

  // Project the raw aggregation rows for return. The caller's output shape is
  // preserved (NoArbiter); we only strip Mongo's internal `_id`/enrichment
  // markers and, where a row is a whole entity, attach the present.ai envelope.
  async project(rows) {
    // Origin history-depth is a batched enrichment (one aggregation for the
    // whole set) — stamp only the rows that are whole entities.
    const entities = rows.filter(r => r && r.address && r.metadata);
    if (entities.length) {
      try { await stampOriginClaims(this.db, entities); } catch { /* enrichment is a courtesy */ }
    }
    return rows.map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
      if (row.address && row.metadata) {
        // A whole entity: attach the fixed present.ai envelope and drop Mongo's
        // internal `_id` and the batched-enrichment marker. `_id` here is the
        // document's ObjectId, noise to the caller.
        let present;
        try { present = toPresentAi(row); } catch { /* leave the raw row */ }
        const { _id, _originClaims, ...rest } = row;
        return present ? { ...rest, present } : rest;
      }
      // A computed / caller-shaped row (e.g. a $group result): return it verbatim.
      // Here `_id` is the caller's own group key, not Mongo's — never strip it,
      // and never fake an origin onto an aggregate (wiki NoArbiter).
      return row;
    });
  }

  async run(req, res, raw, limit) {
    // The policy gate FIRST, and fail CLOSED if it cannot be read — never serve
    // an unfiltered result that might surface a delisted domain (a failed read is
    // not a proven "nothing is delisted"; wiki PredictableFailure).
    let scope;
    try {
      scope = buildDomainExclusionScope(await this.excludedDomains());
    } catch (e) {
      return res.status(503).json({
        error: 'visibility policy unavailable',
        reason: `could not read the delist set, so the query is refused rather than served unfiltered: ${e.message}`,
      });
    }
    const review = reviewPipeline(raw, { limit, scope });
    if (!review.ok) {
      // A refusal explains itself and hands back the rules — a refusal is not a
      // dead end, it is the manual (wiki MeasuredTrust / ReadmeIsTheManual).
      return res.status(400).json({
        error: 'rejected',
        reason: review.error,
        allowedStages: [...ALLOWED_STAGES],
        limits: this.usage(req).rules.limits,
      });
    }
    try {
      const rows = await this.db.collection('entities')
        .aggregate(review.pipeline, { maxTimeMS: review.maxTimeMS, allowDiskUse: false })
        .toArray();
      const results = await this.project(rows);
      let response = {
        service: 'epistery-scan query',
        collection: 'entities',
        results,
        meta: {
          count: results.length,
          limit: review.limit,
          maxTimeMS: review.maxTimeMS,
          stages: review.stages,
        },
      };
      // Provenance, never a gate (lib/sign.mjs): sign the response when a signer
      // is present so a consumer can confirm scan returned it unaltered.
      response = await signResponse(response, req.app?.locals?.epistery?.signer);
      res.json(response);
    } catch (err) {
      // A query that overran its time budget or failed in the engine is a
      // bounded, explicit failure — reported as the caller's query, not a 500.
      const timedOut = err.code === 50 || /time limit|maxTimeMS/i.test(err.message || '');
      res.status(timedOut ? 408 : 422).json({
        error: timedOut ? 'query exceeded its time budget' : 'query failed',
        reason: err.message,
        maxTimeMS: review.maxTimeMS,
      });
    }
  }

  routes() {
    const router = express.Router();

    // GET — the manual when no pipeline is named; otherwise run the pipeline
    // passed as a URL-encoded JSON array in ?pipeline=. Handy for curl and for
    // a bot's first, keyless look.
    router.get('/', async (req, res) => {
      const raw = req.query.pipeline;
      if (raw === undefined || raw === '') {
        return res.json(this.usage(req));
      }
      await this.run(req, res, raw, req.query.limit);
    });

    // POST — the pipeline in the JSON body { pipeline, limit }.
    router.post('/', async (req, res) => {
      const body = req.body || {};
      const raw = body.pipeline ?? body.query ?? (Array.isArray(body) ? body : undefined);
      if (raw === undefined) {
        return res.status(400).json({ error: 'rejected', reason: 'body must carry a `pipeline` (a JSON array of stages)', ...this.usage(req) });
      }
      await this.run(req, res, raw, body.limit);
    });

    return router;
  }
}
