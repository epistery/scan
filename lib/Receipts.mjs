/**
 * Rootz Receipts: origin receipts for AI agent work (receipts.rootz.global). Scan verifies a receipt with
 * the PUBLIC Rootz verifier, vendored byte-for-byte from https://receipts.rootz.global/assets/ask-orders-verifier.js
 * and pinned by SHA-256, run in its own V8 context. Facts, not verdicts: Scan reports what that verifier said about
 * each of the receipt's five lines (status + depth), which build said it, and what that build cannot check.
 *
 * A receipt is found from the answer alone: GET <resolver>/sha256:<base64url SHA-256 of the exact answer bytes>
 * (named by the answer's `Origin-Receipt` header). The resolver is not trusted: only receipts whose response
 * commitment equals the hash are kept, and each is verified on its own.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const BUNDLE = new URL('../vendor/rootz-receipts-verifier.js', import.meta.url);
/** The public build in vendor/ (Rootz-ASK cccedb8, 2026-10-10). Replace both together when Rootz ships a new one. */
export const VERIFIER = { name: 'rootz-receipts-verifier', build: 'cccedb8', sha256: '61421b6cc8ee906d5142d221a337b15b34f7e6d5b353674488635e029fba9484', source: 'https://receipts.rootz.global/assets/ask-orders-verifier.js' };
/** Signature types that build checks. A receipt signed with anything else is beyond it, never "failed". */
export const BUILD_ALGS = new Set(['ed25519', 'ecdsa-p256']);
export const LINES = ['authorized_by', 'specification', 'materials', 'process', 'integrity'];
const RESOLVER_PATH = '/.well-known/origin-receipts/';

let V = null;
export function verifier() {
  if (V) return V;
  const src = readFileSync(BUNDLE);
  const got = createHash('sha256').update(src).digest('hex');
  if (got !== VERIFIER.sha256) throw new Error(`vendored Rootz verifier does not match its pin (${got})`);
  const ctx = vm.createContext({ TextEncoder, TextDecoder, crypto: globalThis.crypto, fetch, console, atob, btoa, URL, setTimeout, clearTimeout });
  vm.runInContext(src.toString('utf8'), ctx, { filename: 'rootz-receipts-verifier.js' });
  V = ctx.AskOrdersVerifier;
  if (!V || typeof V.verify !== 'function') throw new Error('vendored Rootz verifier did not load');
  return V;
}

/** The answer-bytes digest the resolver and the receipt's response commitment use. */
export const answerDigest = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('base64url');

/** Every signature type a receipt's orders use, per order index. */
function orderAlgs(receipt) {
  return (receipt?.orders ?? []).map((o) => {
    const proofs = o?.proofs ?? (o?.proof ? [o.proof] : []);
    return proofs.flatMap((p) => p?.envelope?.algs ?? Object.keys(p?.envelope?.sigs ?? {}));
  });
}

/**
 * Verify one receipt. `answer`/`request` are the exact bytes if the caller has them (without them those lines say
 * what they could not check). `reader` is a chain reader; default: Rootz's Polygon node.
 */
export async function receiptFacts(receipt, { answer, request, rpc = 'https://node.rootz.global/', now } = {}) {
  const v = verifier();
  const opts = { reader: v.rpcReader({ 'eip155:137': rpc }) };
  if (answer) opts.answerBytes = Uint8Array.from(answer);
  if (request) opts.requestBytes = Uint8Array.from(request);
  if (now) opts.now = now;
  const r = await v.verify(receipt, opts);
  // An order signed with a type this build does not check reads "order-signature-invalid" in that build, which is
  // the same code a forgery gets. Report it as beyond this build, and only that check: any other failure stands.
  const beyond = [];
  orderAlgs(receipt).forEach((algs, i) => {
    const unsupported = algs.filter((a) => !BUILD_ALGS.has(a));
    if (unsupported.length && algs.every((a) => !BUILD_ALGS.has(a))) beyond.push({ check: `authorized_by.order.${i}.signature`, algs: unsupported });
  });
  const lines = {};
  for (const n of LINES) {
    const l = r.lines?.[n];
    if (!l) { lines[n] = { status: 'absent' }; continue; }
    const checks = l.checks.map((c) => beyond.some((b) => b.check === c.id) && c.result === 'fail' ? { ...c, result: 'not_evaluable', reason: 'signature-type-beyond-this-verifier-build' } : c);
    const stillFails = checks.some((c) => c.result === 'fail');
    const changed = checks.some((c, i) => c !== l.checks[i]);
    lines[n] = { status: l.status === 'failed' && changed && !stillFails ? 'not-checked' : l.status, depth: l.depth, summary: l.summary, checks };
  }
  return {
    kind: 'epistery.receipt-facts.v1',
    receipt: r.receipt,
    verified_at: r.verified_at,
    verifier: VERIFIER,
    lines,
    ...(r.adversaries ? { holds_against: r.adversaries } : {}),
    ...(beyond.length ? { beyond_this_build: beyond.map((b) => `${b.check}: signed with ${b.algs.join(', ')}, which build ${VERIFIER.build} does not check; verify with the current Rootz verifier`) } : {}),
  };
}

/** Is `url` a resolver locator Scan will call (https, the well-known path)? */
export function resolverBase(url) {
  let u; try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || !u.pathname.endsWith(RESOLVER_PATH)) return null;
  return u.origin + u.pathname;
}

/** Parse an `Origin-Receipt: <url>; by="response-sha256"; …` header into its resolver base. */
export function resolverFromHeader(h) {
  const m = /^\s*<([^>]+)>/.exec(String(h ?? ''));
  return m ? resolverBase(m[1]) : null;
}

/** Find and verify the receipts for an answer hash at a resolver. The resolver is not trusted. */
export async function resolveAndVerify(base, hash, { fetchImpl = fetch, timeoutMs = 8000, ...o } = {}) {
  const b = resolverBase(base);
  if (!b) throw new Error('resolver must be https and end with ' + RESOLVER_PATH);
  if (!/^sha256:[A-Za-z0-9_-]{43}$/.test(hash)) throw new Error('hash must be sha256:<base64url>');
  const res = await fetchImpl(b + hash, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  if (res.status === 404) return { hash, resolver: b, receipts: [] };
  if (!res.ok) throw new Error(`resolver answered ${res.status}`);
  const doc = await res.json();
  const all = Array.isArray(doc?.receipts) ? doc.receipts.slice(0, 20) : [];
  const kept = all.filter((r) => r?.subject?.response?.event?.body?.sha256 === hash);
  const receipts = [];
  for (const r of kept) receipts.push(await receiptFacts(r, o));
  return { hash, resolver: b, on_file: all.length, matching: kept.length, receipts };
}
