// Scan reports facts, never a verdict: the rung is the one derivation from the
// signals (Present.mjs), the signals summary carries presence and time only, and
// a session declaration is hashed and messaged by the shared construction
// (@epistery/client-lib/manifest) — the same the console signs with.
//
//   cd scan && npm test
import { ethers } from 'ethers';
import { rungFromSignals } from '../lib/Present.mjs';
import { summarizeSignals } from '../lib/Posture.mjs';
import { declarationHash, declarationMessage, verifySessionDeclaration } from '../lib/SessionDeclaration.mjs';
import { declarationHash as libHash, declarationMessage as libMessage, verifyManifest, buildManifest } from '@epistery/client-lib/manifest';

let failures = 0; const check = (c, m) => c ? console.log('  ok  : ' + m) : (console.log('  FAIL: ' + m), failures++);
const on = { present: true, at: 1 }, off = { present: false, at: 1 };

check(rungFromSignals({ contractExists: on, domainBinding: on }) === 'chain-bound', 'a contract bound to its domain is chain-bound');
check(rungFromSignals({ contractExists: on, domainBinding: off, dnsVerified: on }) === 'dns', 'DNS alone is the dns rung');
check(rungFromSignals({ domainBinding: on }) === 'dns', 'a one-sided binding is the dns rung, not chain-bound');
check(rungFromSignals({ selfSigned: on }) === 'claimed' && rungFromSignals({}) === 'open' && rungFromSignals() === 'open', 'self-signed is claimed; nothing is open');
check(JSON.stringify(summarizeSignals({ a: { present: true, at: 5, computed: 'x' }, b: null })) === '{"a":{"present":true,"at":5}}', 'a signal summary carries presence and time only');

const d = { title: 'T', description: 'D', audience: '', coreConcepts: [], ads: { enabled: false, agency: '' } };
check(await declarationHash(d) === await libHash(d), 'the declaration hash is the shared module\'s');
check(declarationMessage('0xABC', '0xDEF', 'sha256:1') === libMessage('0xABC', '0xDEF', 'sha256:1'), 'the declaration message is the shared module\'s');
check(await declarationHash({ ...d, _signature: { x: 1 } }) === await declarationHash(d), '_signature is outside the hash');

// A declaration signed by an admin rivet verifies; the contract is asked, and
// a contract that did not answer is reported as a reason, not as unauthorized-by-fact.
const w = ethers.Wallet.createRandom();
const owner = '0x80f84221dcCC8d049f34b449DFC825B6940BD85f', session = '0x67d6a9e71b27D60178430A2892Ad500eBA17B630';
const hash = await declarationHash(d);
const signed = { ...d, _signature: { digitalName: owner, session, signer: w.address, contentHash: hash, signature: await w.signMessage(declarationMessage(owner, session, hash)) } };
let facts = await verifySessionDeclaration({ contractAddress: owner, session, declaration: signed, contract: { authorized: async (s, who, role) => who === w.address && role === 3 } });
check(facts.signed && facts.hashValid && facts.authorized && facts.signer === w.address, 'an admin-signed declaration verifies against the contract');
facts = await verifySessionDeclaration({ contractAddress: owner, session, declaration: signed, contract: { authorized: async () => { throw new Error('rpc down'); } } });
check(facts.signed && facts.hashValid && facts.authorized === false && /did not answer/.test(facts.reason), 'a contract that did not answer is named as the reason');
facts = await verifySessionDeclaration({ contractAddress: owner, session, declaration: { ...signed, title: 'tampered' }, contract: { authorized: async () => true } });
check(facts.hashValid === false, 'a tampered declaration fails the hash');

// A domain manifest built by the shared module verifies here with ethers v6 recovery.
const dw = ethers.Wallet.createRandom();
const doc = await buildManifest({ domain: 'example.test', signer: dw, chainId: 137, providerName: 'polygon', version: '0', searchUrl: '/scan' });
const v = await verifyManifest(doc, ethers.verifyMessage);
check(v.ok && v.signer === dw.address, 'a signed domain manifest verifies with v6 recovery');

console.log(failures ? `SCAN FAIL (${failures})` : 'SCAN PASS');
process.exit(failures ? 1 : 0);
