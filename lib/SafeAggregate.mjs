/**
 * SafeAggregate — review a caller-supplied MongoDB aggregation pipeline for
 * syntax and safety, and return a bounded, read-only pipeline ready to run.
 *
 * This is the whole gate between a bot's query string and scan's index. It is a
 * PURE function (no database, no network) so it can be reasoned about and tested
 * exhaustively on its own. The handler that runs the returned pipeline adds the
 * resource bounds this module computes (maxTimeMS, allowDiskUse:false) at the
 * driver call.
 *
 * The posture, in order:
 *   1. SYNTAX — the input parses to an array of single-operator stages.
 *   2. SAFETY — fail CLOSED. Stages are an ALLOWLIST (anything not named is
 *      refused, so a write/admin/cross-collection stage we have never heard of
 *      is refused by default, not by having remembered to ban it). On top of
 *      that, a recursive scan refuses a handful of operators that execute code
 *      or reach another collection even when they hide inside an expression.
 *   3. RESOURCE (see wiki ResourceLens — barriers argued as resources, not
 *      mathematics). A bounded stage count, a bounded result size appended as a
 *      trailing $limit, a bounded nesting depth, and the maxTimeMS the caller
 *      must run it under. A query that cannot be bounded is refused, never
 *      run-and-hope.
 *
 * What it deliberately does NOT do: decide WHAT the caller may ask (that is the
 * caller's policy — wiki NoArbiter) or re-shape the output (the caller controls
 * the projection; the handler only attaches origin facts where a row is a whole
 * entity). It only proves the query cannot write, cannot execute code, cannot
 * leave the one public collection, and cannot run unbounded.
 */

// Read stages only. An allowlist, so the failure mode for anything unlisted —
// including stages that do not exist yet — is refusal. Every stage here takes
// expression objects alone (no embedded sub-pipeline, no foreign collection);
// the sub-pipeline stages ($facet, $lookup, $graphLookup, $unionWith) are
// deliberately absent and reviewed for separately, so the recursive scan below
// never has to descend into a nested pipeline.
export const ALLOWED_STAGES = new Set([
  '$match', '$project', '$addFields', '$set', '$unset',
  '$group', '$sortByCount', '$bucket', '$bucketAuto', '$count',
  '$sort', '$limit', '$skip', '$unwind', '$sample',
  '$replaceRoot', '$replaceWith',
]);

// Operators that execute arbitrary JavaScript inside an expression. These are
// the ONLY things the recursive scan hunts, because they are the only dangerous
// operators that can legally hide inside an ordinary expression ($match,
// $addFields, $group) rather than appearing as a stage. Everything else that is
// dangerous — writes ($out, $merge), cross-collection reads ($lookup,
// $graphLookup, $unionWith, $documents), sub-pipeline fan-out ($facet), server
// introspection ($collStats, $indexStats, …) and Atlas search stages ($search,
// $searchMeta, $vectorSearch) — is a STAGE, already refused by the stage
// allowlist (fail closed), so it never needs a key-name scan.
//
// Scanning by key name conflated two different `$search`es: the Atlas search
// STAGE (refused by the allowlist) and the operand of a standard full-text
// query, `{$text: {$search: "…"}}` — which is read-only, rides the existing
// text index, and is exactly the fast path a caller wants. Hunting only the
// code-execution trio lets `$text` through while the allowlist still refuses
// `$search` (and the rest) as stages.
export const FORBIDDEN_OPERATORS = new Set([
  '$where', '$function', '$accumulator',
]);

export const LIMITS = Object.freeze({
  MAX_STAGES: 24,     // a pipeline longer than this is doing too much in one call
  MAX_LIMIT: 200,     // the most rows one query may return
  DEFAULT_LIMIT: 50,  // the cap applied when the caller named none
  MAX_TIME_MS: 5000,  // the driver-level deadline the handler must enforce
  MAX_DEPTH: 40,      // object/array nesting ceiling (refuses pathological input)
});

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// Walk every value, refusing a forbidden operator key or excessive depth. The
// scan is key-based: a `$where` property anywhere, at any nesting, is the thing
// we refuse, regardless of what stage it sits in.
function scanForForbidden(node, depth, limits) {
  if (depth > limits.MAX_DEPTH) {
    return `the query nests deeper than ${limits.MAX_DEPTH} levels`;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const err = scanForForbidden(item, depth + 1, limits);
      if (err) return err;
    }
    return null;
  }
  if (isPlainObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith('$') && FORBIDDEN_OPERATORS.has(key)) {
        return `operator ${key} is not permitted`;
      }
      const err = scanForForbidden(value, depth + 1, limits);
      if (err) return err;
    }
  }
  return null;
}

function isNonNegativeInteger(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

// Apply the scope $match (the policy gate) without ever placing a stage ahead
// of a `$text` search — Mongo requires $text to be in the FIRST stage of the
// pipeline, so a prepended scope stage would make a legitimate $text query
// illegal. When the caller's first stage is itself a $match, the scope is folded
// INTO it (which also lets that stage's indexed clause keep its index); only
// when the first stage is not a $match is a scope stage prepended.
function applyScope(pipeline, scope) {
  if (!scope || typeof scope !== 'object') return [...pipeline];
  const first = pipeline[0];
  if (first && first.$match && typeof first.$match === 'object' && !Array.isArray(first.$match)) {
    return [{ $match: foldIntoMatch(first.$match, scope) }, ...pipeline.slice(1)];
  }
  return [{ $match: scope }, ...pipeline];
}

// Combine the caller's first $match with the scope. Scope is always a single
// `{$expr: …}`. With no $text present, a plain $and is cleanest and always
// valid. With $text present it must stay a top-level key, so the scope's keys
// are merged in beside it (two $expr bodies, if both exist, join under $and).
function foldIntoMatch(callerMatch, scope) {
  if (!('$text' in callerMatch)) return { $and: [callerMatch, scope] };
  const merged = { ...callerMatch };
  for (const [k, v] of Object.entries(scope)) {
    if (k === '$expr' && merged.$expr) merged.$expr = { $and: [merged.$expr, v] };
    else merged[k] = v;
  }
  return merged;
}

/**
 * Review a pipeline.
 *
 * @param {string|Array} input  a JSON string of the pipeline, or the array itself.
 * @param {object} [opts]
 * @param {number} [opts.limit]     the caller's requested result cap (clamped to MAX_LIMIT).
 * @param {object} [opts.scope]     a $match filter scan PREPENDS before the caller's
 *                                  stages — the policy gate (e.g. drop delisted
 *                                  domains). It runs upstream of everything, so a
 *                                  pruned row is invisible even to a $group count.
 *                                  Scan-owned and trusted; not subject to the
 *                                  caller checks. Omitted when there is nothing to prune.
 * @param {object} [opts.limits]    override the LIMITS constants (tests).
 * @returns {{ok:true, pipeline:Array, limit:number, maxTimeMS:number, stages:string[]}
 *          | {ok:false, error:string}}
 */
export function reviewPipeline(input, opts = {}) {
  const limits = { ...LIMITS, ...(opts.limits || {}) };

  // ── 1. syntax: parse to an array of stages ──
  let pipeline = input;
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) return { ok: false, error: 'the pipeline is empty' };
    try {
      pipeline = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: `the pipeline is not valid JSON: ${e.message}` };
    }
  }
  if (!Array.isArray(pipeline)) {
    return { ok: false, error: 'the pipeline must be an array of stages (a JSON array)' };
  }
  if (pipeline.length === 0) {
    return { ok: false, error: 'the pipeline is empty' };
  }
  if (pipeline.length > limits.MAX_STAGES) {
    return { ok: false, error: `the pipeline has ${pipeline.length} stages; the most allowed is ${limits.MAX_STAGES}` };
  }

  // ── 2. each stage: exactly one $operator, and it must be on the allowlist ──
  const stages = [];
  for (let i = 0; i < pipeline.length; i++) {
    const stage = pipeline[i];
    if (!isPlainObject(stage)) {
      return { ok: false, error: `stage ${i + 1} is not an object` };
    }
    const keys = Object.keys(stage);
    if (keys.length !== 1) {
      return { ok: false, error: `stage ${i + 1} must name exactly one operator, found ${keys.length}` };
    }
    const op = keys[0];
    if (!op.startsWith('$')) {
      return { ok: false, error: `stage ${i + 1} key "${op}" is not an aggregation operator` };
    }
    if (!ALLOWED_STAGES.has(op)) {
      return { ok: false, error: `stage ${op} is not permitted; allowed stages are: ${[...ALLOWED_STAGES].join(', ')}` };
    }
    // $limit / $skip must be sane non-negative integers.
    if (op === '$limit' || op === '$skip') {
      if (!isNonNegativeInteger(stage[op])) {
        return { ok: false, error: `${op} must be a non-negative integer` };
      }
    }
    stages.push(op);
  }

  // ── 3. safety: no code-executing / write / cross-collection operator anywhere ──
  const forbidden = scanForForbidden(pipeline, 0, limits);
  if (forbidden) return { ok: false, error: forbidden };

  // ── 4. resource bounds: clamp the result size and append it as a trailing cap ──
  let limit = limits.DEFAULT_LIMIT;
  if (opts.limit != null) {
    const n = Number(opts.limit);
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, error: 'limit must be a positive number' };
    }
    limit = Math.min(Math.floor(n), limits.MAX_LIMIT);
  }
  // Couch the caller's search between scan's own stages (the sandwich Michael
  // named): the scope $match PRUNES BEFORE, upstream of everything, so a delisted
  // domain's rows never enter the caller's pipeline and cannot surface in a row
  // OR be counted in a $group; the trailing $limit PRUNES AFTER, bounding the
  // output no matter what the caller's stages produced (additive, never widening
  // an earlier smaller limit). The scope is scan-owned and trusted, so it is not
  // subject to the caller checks above.
  const safePipeline = [...applyScope(pipeline, opts.scope), { $limit: limit }];

  return {
    ok: true,
    pipeline: safePipeline,
    limit,
    maxTimeMS: limits.MAX_TIME_MS,
    stages,
  };
}
