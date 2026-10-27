// A domain controls its own presence in scan through its DomainContract's
// public attributes (VISIBILITY), and a domain that has gone dark in DNS for
// the grace window is cleaned out. Both facts are the domain's own. These are
// the pure decisions, tested without a DB, a chain, or a clock of their own.
//
//   node test/domainPolicy.test.mjs
import { interpretVisibility, nextUnresolved, advanceClock, dnsState, reachState, staleExpired } from '../ingestion/DomainPolicy.mjs';

let failures = 0;
const check = (c, m) => c ? console.log('  ok  : ' + m) : (console.log('  FAIL: ' + m), failures++);
const DAY = 86400000;

// ── VISIBILITY, read loosely ──
check(interpretVisibility({ VISIBILITY: 'NONE' }).listable === false, 'VISIBILITY=NONE is not listable');
check(interpretVisibility({ visibility: 'none' }).listable === false, 'lowercase key and value both match');
check(interpretVisibility({ Visibility: ' Off ' }).listable === false, 'value is trimmed and case-folded');
for (const v of ['no', 'off', 'false', '0', 'hidden', 'private', 'never', 'noindex', 'nolist']) {
  check(interpretVisibility({ VISIBILITY: v }).listable === false, `VISIBILITY=${v} suppresses`);
}
check(interpretVisibility({ VISIBILITY: 'public' }).listable === true, 'an unknown VISIBILITY value stays listable');
check(interpretVisibility({ VISIBILITY: 'all' }).listable === true, 'VISIBILITY=all is listable');
check(interpretVisibility({}).listable === true, 'no attributes → listable');
check(interpretVisibility(null).listable === true, 'null attributes → listable');
check(interpretVisibility({ terms: 'https://spdx.org/licenses/MIT' }).listable === true, 'an unrelated directive does not suppress');
check(interpretVisibility({ VISIBILITY: 'NONE' }).visibility === 'NONE', 'the raw value is carried through verbatim');

// ── the DNS-unresolved clock ──
const T0 = new Date('2026-01-01T00:00:00Z');
const T1 = new Date('2026-01-10T00:00:00Z');
check(nextUnresolved(T0, { resolves: true }, T1) === null, 'a live answer clears the clock');
check(nextUnresolved(null, { resolves: false, error: null }, T1) === T1, 'a clean NXDOMAIN starts the clock now');
check(nextUnresolved(T0, { resolves: false, error: null }, T1) === T0, 'a continuing NXDOMAIN keeps the original start');
check(nextUnresolved(T0, { resolves: false, error: 'ESERVFAIL' }, T1) === T0, 'a transient failure leaves a running clock untouched');
check(nextUnresolved(null, { resolves: false, error: 'ETIMEOUT' }, T1) === null, 'a transient failure never starts the clock');

// ── the shared clock + state mappings ──
check(advanceClock(T0, 'ok', T1) === null, "'ok' clears any clock");
check(advanceClock(null, 'gone', T1) === T1, "'gone' starts the clock now");
check(advanceClock(T0, 'gone', T1) === T0, "'gone' keeps an existing start");
check(advanceClock(T0, 'unknown', T1) === T0, "'unknown' holds a running clock");
check(advanceClock(null, 'unknown', T1) === null, "'unknown' never starts a clock");
check(dnsState({ resolves: true }) === 'ok', 'DNS resolves → ok');
check(dnsState({ resolves: false, error: null }) === 'gone', 'DNS clean NXDOMAIN → gone');
check(dnsState({ resolves: false, error: 'ESERVFAIL' }) === 'unknown', 'DNS transient → unknown');

// ── reachability: resolves-but-dead (the epistery.app case) ──
check(reachState({ reachable: true, status: 200 }) === 'ok', 'an HTTP 200 is reachable');
check(reachState({ reachable: true, status: 503 }) === 'ok', 'even a 5xx means a server answered → reachable');
check(reachState({ reachable: false, code: 'ECONNREFUSED' }) === 'gone', 'a refused connection is a dead service');
check(reachState({ reachable: null, code: 'AbortError' }) === 'unknown', 'a timeout is don’t-know, never dead');
check(reachState({ reachable: null, code: 'ECONNRESET' }) === 'unknown', 'a reset is don’t-know, never dead');

// ── grace ──
const now = new Date('2026-02-01T00:00:00Z');
check(staleExpired(null, now, 30 * DAY) === false, 'no clock → never stale');
check(staleExpired(new Date(now.getTime() - 10 * DAY), now, 30 * DAY) === false, '10 days < 30-day grace → not yet');
check(staleExpired(new Date(now.getTime() - 31 * DAY), now, 30 * DAY) === true, '31 days > 30-day grace → stale');
check(staleExpired(new Date(now.getTime() - 30 * DAY), now, 30 * DAY) === true, 'exactly the grace boundary is stale');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall passed');
process.exit(failures ? 1 : 0);
