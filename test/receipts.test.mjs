// Rootz Receipts verified with the vendored PUBLIC Rootz verifier (lib/Receipts.mjs). The real-receipt checks use two
// Rootz test vectors ({receipt, answer_b64, request_b64, chain}, chain reads recorded), passed in by path:
//   RECEIPT_EC=<vector with an EC-signed order> RECEIPT_RSA=<vector with an RSA-signed order> node test/receipts.test.mjs
import { readFileSync, existsSync } from 'node:fs';
import { receiptFacts, resolveAndVerify, resolverFromHeader, answerDigest, verifier, VERIFIER } from '../lib/Receipts.mjs';

let failures = 0; const check = (c, m) => c ? console.log('  ok  : ' + m) : (console.log('  FAIL: ' + m), failures++);

check(typeof verifier().verify === 'function', `the vendored verifier loads and matches its pin (${VERIFIER.build})`);
check(resolverFromHeader('<https://receipts.rootz.global/.well-known/origin-receipts/>; by="response-sha256"; request="x"') === 'https://receipts.rootz.global/.well-known/origin-receipts/', 'an Origin-Receipt header names its resolver');
check(resolverFromHeader('<http://127.0.0.1:1/.well-known/origin-receipts/>') === null && resolverFromHeader('<https://evil.example/anything>') === null, 'a non-https or non-well-known resolver is refused');
check(answerDigest(Buffer.from('abc')) === 'sha256:ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0', 'the answer digest is sha256 base64url');

const EC = process.env.RECEIPT_EC, RSA = process.env.RECEIPT_RSA;
if (EC && RSA && existsSync(EC) && existsSync(RSA)) {
  const b = (s) => s && Buffer.from(s, 'base64');
  const load = (p) => JSON.parse(readFileSync(p, 'utf8'));
  // The reader the vectors recorded, so the test does not depend on the live chain.
  const v = verifier();
  const facts = async (x, receipt = x.receipt) => {
    const { receiptFacts: rf } = await import('../lib/Receipts.mjs');
    const orig = v.rpcReader; v.rpcReader = () => v.recordedReader(x.chain);
    try { return await rf(receipt, { answer: b(x.answer_b64), request: b(x.request_b64) }); } finally { v.rpcReader = orig; }
  };

  const svc = load(EC);
  let f = await facts(svc);
  check(f.lines.authorized_by.status === 'verified' && f.lines.integrity.status === 'verified' && f.lines.materials.status === 'verified', 'an EC-signed receipt: Authorized by, Materials, Integrity verified');
  check(f.lines.process.status === 'asserted', 'its Process reads asserted in this build (not overstated)');
  check(!f.beyond_this_build, 'nothing beyond this build');

  const ask = load(RSA);
  f = await facts(ask);
  check(f.lines.authorized_by.status === 'not-checked', 'an RSA-signed order is beyond this build: not-checked, never failed');
  check(f.beyond_this_build?.length === 1 && /rsa-pkcs1-sha256/.test(f.beyond_this_build[0]), 'and Scan says why');
  check(f.lines.integrity.status === 'verified', 'the rest still verifies');

  // Negatives: a changed answer byte, and an edited order, still fail.
  const ans = Buffer.from(svc.answer_b64, 'base64'); ans[0] ^= 1;
  f = await facts({ ...svc, answer_b64: ans.toString('base64') });
  check(f.lines.materials.status === 'failed' || f.lines.specification.status === 'failed' || f.lines.integrity.status === 'failed', 'a changed answer byte fails');
  const m = structuredClone(svc.receipt); m.orders[0].body.policy.digest = 'sha256:' + 'A'.repeat(43);
  f = await facts(svc, m);
  check(f.lines.authorized_by.status === 'failed', 'an edited EC-signed order fails');
  const m2 = structuredClone(ask.receipt); m2.orders[0].body.policy.digest = 'sha256:' + 'A'.repeat(43);
  f = await facts(ask, m2);
  check(f.lines.process.status === 'failed' && f.lines.authorized_by.status !== 'verified', 'an edited RSA-signed order is never verified: Process fails (the order chain no longer matches)');

  // The resolver is not trusted: a receipt for other bytes is dropped.
  const hash = svc.receipt.subject.response.event.body.sha256;
  const fake = async () => ({ ok: true, status: 200, json: async () => ({ receipts: [svc.receipt, { ...structuredClone(svc.receipt), subject: { response: { event: { body: { sha256: 'sha256:' + 'B'.repeat(43) } } } } }] }) });
  const orig = v.rpcReader; v.rpcReader = () => v.recordedReader(svc.chain);
  const res = await resolveAndVerify('https://receipts.rootz.global/.well-known/origin-receipts/', hash, { fetchImpl: fake, answer: b(svc.answer_b64), request: b(svc.request_b64) });
  v.rpcReader = orig;
  check(res.on_file === 2 && res.matching === 1 && res.receipts[0].lines.integrity.status === 'verified', 'resolver: only the receipt committing to these bytes is kept, and it verifies');
} else console.log('  skip: set RECEIPT_EC and RECEIPT_RSA for the real-receipt checks');

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall receipt checks pass');
