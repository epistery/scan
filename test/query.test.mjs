// The bot-facing aggregation surface: the safety reviewer that stands between a
// caller's pipeline and the index, and the handler that runs a reviewed pipeline
// and projects the rows.
//
// The reviewer checks are pure (no database) and always run. The handler checks
// need a throwaway Mongo and are skipped (not failed) when none is reachable:
//   MONGO=mongodb://127.0.0.1:27017 node test/query.test.mjs
import { reviewPipeline, LIMITS } from '../lib/SafeAggregate.mjs';
import QueryHandler from '../handlers/Query.mjs';

let failures = 0;
const check = (c, m) => c ? console.log('  ok  : ' + m) : (console.log('  FAIL: ' + m), failures++);

// ── the reviewer: syntax ──
check(reviewPipeline('not json').ok === false, 'a non-JSON string is refused');
check(reviewPipeline('{"$match":{}}').ok === false, 'a JSON object that is not an array is refused');
check(reviewPipeline([]).ok === false, 'an empty pipeline is refused');
check(reviewPipeline('   ').ok === false, 'a blank string is refused');
check(reviewPipeline([{ $match: {} }, { foo: 1 }]).ok === false, 'a stage whose key is not an operator is refused');
check(reviewPipeline([{ $match: {}, $sort: {} }]).ok === false, 'a stage with two operators is refused');
check(reviewPipeline([42]).ok === false, 'a stage that is not an object is refused');
check(reviewPipeline(Array(LIMITS.MAX_STAGES + 1).fill({ $match: {} })).ok === false, 'a pipeline over the stage ceiling is refused');

// a valid pipeline passes, gets a trailing $limit, and reports its stages
let r = reviewPipeline([{ $match: { type: 'Object' } }, { $sort: { _modified: -1 } }]);
check(r.ok === true, 'a simple read pipeline passes');
check(r.pipeline.length === 3 && JSON.stringify(r.pipeline[2]) === JSON.stringify({ $limit: LIMITS.DEFAULT_LIMIT }), 'a trailing $limit is appended at the default cap');
check(r.maxTimeMS === LIMITS.MAX_TIME_MS && r.stages.join() === '$match,$sort', 'the review returns the time budget and the stage list');

// the string form parses to the same result
check(reviewPipeline('[{"$match":{"type":"Object"}}]').ok === true, 'the pipeline may be passed as a JSON string');

// limit is clamped, never widened past the ceiling
check(reviewPipeline([{ $match: {} }], { limit: 99999 }).limit === LIMITS.MAX_LIMIT, 'a huge requested limit is clamped to the ceiling');
check(reviewPipeline([{ $match: {} }], { limit: 5 }).limit === 5, 'a small requested limit is honored');
check(reviewPipeline([{ $match: {} }], { limit: -1 }).ok === false, 'a non-positive limit is refused');

// a scope is couched as a $match BEFORE the caller's stages (prune-before)
let sc = reviewPipeline([{ $sort: { x: 1 } }], { scope: { secret: { $ne: true } } });
check(sc.ok && sc.pipeline.length === 3 && JSON.stringify(sc.pipeline[0]) === JSON.stringify({ $match: { secret: { $ne: true } } }), 'a scope is prepended as the first $match stage, ahead of the caller');
check(JSON.stringify(reviewPipeline([{ $sort: { x: 1 } }]).pipeline[0]) === JSON.stringify({ $sort: { x: 1 } }), 'with no scope the caller stage stays first');

// ── the reviewer: safety (allowlist) ──
for (const stage of ['$out', '$merge', '$lookup', '$graphLookup', '$unionWith', '$facet', '$collStats', '$indexStats', '$documents', '$changeStream']) {
  check(reviewPipeline([{ [stage]: {} }]).ok === false, `the ${stage} stage is refused`);
}
for (const stage of ['$match', '$project', '$group', '$sort', '$unwind', '$count', '$bucket', '$addFields', '$sortByCount', '$sample', '$replaceRoot']) {
  // $count takes a string, $unwind a path, $sample a size — shape-agnostic here; the allowlist is what we assert
  check(reviewPipeline([{ [stage]: stage === '$count' ? 'n' : (stage === '$unwind' ? '$x' : {}) }]).ok === true, `the ${stage} stage is allowed`);
}

// ── the reviewer: safety (code execution, nested anywhere) ──
check(reviewPipeline([{ $match: { $where: 'this.x==1' } }]).ok === false, '$where hidden inside $match is refused');
check(reviewPipeline([{ $match: { $expr: { $function: { body: 'f', args: [], lang: 'js' } } } }]).ok === false, '$function hidden inside $expr is refused');
check(reviewPipeline([{ $group: { _id: null, n: { $accumulator: {} } } }]).ok === false, '$accumulator hidden inside $group is refused');
check(reviewPipeline([{ $match: { $expr: { $gt: ['$a', 1] } } }]).ok === true, '$expr without a code operator is allowed');

// pathological nesting is refused rather than walked forever
let deep = { $gt: 1 };
for (let i = 0; i < LIMITS.MAX_DEPTH + 5; i++) deep = { $and: [deep] };
check(reviewPipeline([{ $match: deep }]).ok === false, 'a pipeline nested past the depth ceiling is refused');

// $limit / $skip must be sane
check(reviewPipeline([{ $match: {} }, { $skip: -3 }]).ok === false, 'a negative $skip is refused');
check(reviewPipeline([{ $match: {} }, { $limit: 2.5 }]).ok === false, 'a fractional $limit is refused');

console.log(`  -- reviewer: ${failures ? failures + ' failed' : 'all passed'} --`);

// ── the handler, over a throwaway Mongo ──
let mongodb;
try { mongodb = (await import('mongodb')).default; } catch { mongodb = null; }
const MONGO = process.env.MONGO || 'mongodb://127.0.0.1:27017';
let client = null;
try {
  if (mongodb) client = await mongodb.MongoClient.connect(MONGO, { serverSelectionTimeoutMS: 2000 });
} catch { client = null; }

if (!client) {
  console.log('  -- handler checks SKIPPED (no Mongo at ' + MONGO + ') --');
} else {
  const db = client.db('query-test-' + Date.now());
  const on = { present: true, at: new Date() };
  await db.collection('entities').insertMany([
    { address: 'ad:camp1', type: 'Object', chain: 'polygon',
      metadata: { source: { name: 'adnet', domain: 'geist.social', url: 'https://geist.social/c/1', author: '0xAAA' },
        object: { type: 'Campaign', schema: 'Campaign', title: 'Summer Sale', summary: 'A campaign' },
        signals: { contractExists: on } }, _created: new Date(), _modified: new Date(2026, 0, 2) },
    { address: 'ad:camp2', type: 'Object', chain: 'polygon',
      metadata: { source: { name: 'adnet', domain: 'geist.social', url: 'https://geist.social/c/2', author: '0xAAA' },
        object: { type: 'Campaign', schema: 'Campaign', title: 'Winter Sale', summary: 'Another' },
        signals: { contractExists: on } }, _created: new Date(), _modified: new Date(2026, 0, 5) },
    { address: 'car:vin9', type: 'Object',
      metadata: { source: { name: 'cars', domain: 'dealers.example', url: 'https://dealers.example/v/9', author: '0xBBB' },
        object: { type: 'Vehicle', schema: 'Vehicle', title: 'Honda Civic' } }, _created: new Date(), _modified: new Date(2026, 0, 3) },
    { address: 'rootz.global', type: 'AIDiscovery',
      metadata: { manifest: { organization: { name: 'Rootz' } }, signals: { dnsVerified: on } }, _created: new Date(), _modified: new Date(2026, 0, 1) },
  ]);

  // The delist set the handler consults. A stub standing in for the Database
  // owner (getUnlistableDomains); flip `unlistable` per check, or 'THROW' to
  // prove the fail-closed path.
  let unlistable = [];
  const database = { getUnlistableDomains: async () => { if (unlistable === 'THROW') throw new Error('domains collection down'); return unlistable; } };
  const handler = new QueryHandler({ db }, database);
  handler.setIngestion({ appDirectory: { retired: new Set() } });

  // a tiny res double that captures status + json
  const fakeRes = () => { const o = { code: 200, body: null }; o.status = (c) => { o.code = c; return o; }; o.json = (b) => { o.body = b; return o; }; return o; };
  const fakeReq = (over = {}) => ({ protocol: 'https', get: (h) => ({ host: 'epistery.com' }[h.toLowerCase()] || ''), baseUrl: '/scan/api/query', query: {}, body: {}, app: { locals: {} }, ...over });

  // 1. a Campaign query returns both campaigns, each with a present.ai envelope
  let res = fakeRes();
  await handler.run(fakeReq(), res, [{ $match: { 'metadata.object.type': 'Campaign' } }, { $sort: { _modified: -1 } }], undefined);
  check(res.code === 200 && res.body.results.length === 2, 'a $match on object type returns the matching entities');
  check(res.body.results[0].present?.type === 'Campaign' && res.body.results[0].present?.locator?.fetch === 'https://geist.social/c/2',
    'an entity row carries the present.ai envelope with its live locator (PullOnHit)');
  check(res.body.results[0].present?.origin?.address === '0xAAA' && res.body.results[0]._id === undefined,
    'origin facts are stamped and Mongo\'s _id is stripped');
  check(res.body.meta.count === 2 && res.body.meta.stages.join() === '$match,$sort', 'meta reports the count and the stages run');

  // 2. a $group aggregate returns computed rows verbatim (no faked origin)
  res = fakeRes();
  await handler.run(fakeReq(), res, [{ $group: { _id: '$metadata.object.type', n: { $sum: 1 } } }, { $sort: { n: -1 } }], undefined);
  const byType = Object.fromEntries((res.body.results || []).map(x => [x._id, x.n]));
  check(res.code === 200 && byType.Campaign === 2 && byType.Vehicle === 1, 'a $group computes counts per declared type (the _id group key is preserved)');
  check(res.body.results.every(x => x.present === undefined), 'a computed aggregate row carries no present envelope — origin is not faked');

  // 3. the result cap is enforced by the appended trailing $limit
  res = fakeRes();
  await handler.run(fakeReq(), res, [{ $match: {} }], 2);
  check(res.code === 200 && res.body.results.length === 2 && res.body.meta.limit === 2, 'the requested limit caps the result set');

  // 4. an unsafe pipeline is refused with the rules, never run
  res = fakeRes();
  await handler.run(fakeReq(), res, [{ $match: {} }, { $merge: { into: 'evil' } }], undefined);
  check(res.code === 400 && res.body.error === 'rejected' && Array.isArray(res.body.allowedStages), 'a $merge write is refused 400 with the allowed-stage list');

  // 5. GET with no pipeline returns the usage recipe (the manual)
  res = fakeRes();
  await handler.routes(); // ensure routes build without throwing
  const usage = handler.usage(fakeReq());
  check(usage.collection === 'entities' && Array.isArray(usage.rules.allowedStages) && usage.example.pipeline.length === 3,
    'the usage recipe names the collection, the allowed stages, and a worked example');
  check(usage.how.GET.startsWith('https://epistery.com/scan/api/query?') && usage.how.POST.startsWith('https://epistery.com/scan/api/query'),
    'the recipe advertises the mount-aware URL (/scan/api/query), not a guessed /api/query');

  // ── policy: a delisted domain is pruned BEFORE the caller's pipeline ──
  // Two rows under a domain that has delisted itself: a signed domain (address IS
  // the domain) and an imported object (domain in metadata.source.domain).
  await db.collection('entities').insertMany([
    { address: 'dark.example', type: 'AIDiscovery',
      metadata: { manifest: { organization: { name: 'Gone Dark' } }, signals: { dnsVerified: on } }, _created: new Date(), _modified: new Date(2026, 0, 9) },
    { address: 'car:darkvin', type: 'Object',
      metadata: { source: { name: 'cars', domain: 'dark.example', url: 'https://dark.example/v/1', author: '0xCCC' },
        object: { type: 'Vehicle', schema: 'Vehicle', title: 'Hidden Car' } }, _created: new Date(), _modified: new Date(2026, 0, 9) },
  ]);

  // With the domain delisted, neither row may appear in a broad query …
  unlistable = ['dark.example'];
  res = fakeRes();
  await handler.run(fakeReq(), res, [{ $match: {} }], 100);
  const addrs = res.body.results.map(r => r.address || r.present?.headline);
  check(res.code === 200 && !res.body.results.some(r => r.address === 'dark.example' || r.address === 'car:darkvin'),
    'a delisted domain\'s rows are pruned from a broad query (prune-before)');
  check(res.body.results.some(r => r.address === 'ad:camp1'), 'a listed domain\'s rows still come through the gate');

  // … nor be counted in an aggregate (the prune is upstream of $group) …
  res = fakeRes();
  await handler.run(fakeReq(), res, [{ $group: { _id: '$type', n: { $sum: 1 } } }], undefined);
  const counts = Object.fromEntries((res.body.results || []).map(x => [x._id, x.n]));
  check(counts.AIDiscovery === 1 && counts.Object === 3,
    'a delisted row is excluded from a $group count, not just hidden from rows');

  // … and the gate is load-bearing: list the domain again and the rows return.
  unlistable = [];
  res = fakeRes();
  await handler.run(fakeReq(), res, [{ $group: { _id: '$type', n: { $sum: 1 } } }], undefined);
  const counts2 = Object.fromEntries((res.body.results || []).map(x => [x._id, x.n]));
  check(counts2.AIDiscovery === 2 && counts2.Object === 4, 'with nothing delisted the dark rows are present — the gate is what excluded them');

  // A failed read of the delist set FAILS CLOSED (503), never serves unfiltered.
  unlistable = 'THROW';
  res = fakeRes();
  await handler.run(fakeReq(), res, [{ $match: {} }], undefined);
  check(res.code === 503 && /delist/i.test(res.body.reason || ''), 'a delist-set read failure refuses the query (fail closed), not an unfiltered result');

  await db.dropDatabase();
  await client.close();
  console.log('  -- handler checks ran --');
}

console.log(failures ? `QUERY FAIL (${failures})` : 'QUERY PASS');
process.exit(failures ? 1 : 0);
