/**
 * Session declarations — what a session of an IdentityContract says about itself.
 *
 * A session is an inner page of its identity: the identity's host declares it
 * (kind, name, title) in the contract-home read, and the session may carry its
 * own declaration — title, description, audience, core concepts, whether it
 * carries ads — signed by one of its admins (console/client/declaration.mjs).
 *
 * The host is not the voucher; the CONTRACT is. So the check here is the chain's:
 *   1. the content hash recomputes (keys deep-sorted, compact JSON, no _signature)
 *   2. the signature recovers a signer over the exact construction
 *        epistery-session-declaration\n1\n<contract>\n<session>\n<contentHash>
 *   3. the contract answers authorized(<session>, signer, ROLE_ADMIN)
 * Facts, not a verdict: each check is reported on its own, with when it was read.
 */
import crypto from 'crypto';
import { ethers } from 'ethers';

const ROLE_ADMIN = 3;

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

export function declarationHash(declaration) {
  const { _signature, ...content } = declaration || {};
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(sortKeys(content))).digest('hex');
}

export function declarationMessage(contract, session, contentHash) {
  return `epistery-session-declaration\n1\n${String(contract).toLowerCase()}\n${String(session).toLowerCase()}\n${contentHash}`;
}

/**
 * @param {object} p
 * @param {string} p.contractAddress  the IdentityContract that owns the session
 * @param {string} p.session          the session id (its section on the contract)
 * @param {object} p.declaration      the declaration as the host served it
 * @param {object} p.contract         an ethers Contract over the identity, with authorized()
 * @returns {Promise<object>} { at, signed, hashValid, signer, authorized, reason? }
 */
export async function verifySessionDeclaration({ contractAddress, session, declaration, contract }) {
  const at = new Date();
  const sig = declaration?._signature;
  if (!sig?.signature || !sig?.contentHash) {
    return { at, signed: false, hashValid: false, signer: null, authorized: false, reason: 'unsigned' };
  }
  const eq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
  if (!eq(sig.digitalName, contractAddress) || !eq(sig.session, session)) {
    return { at, signed: false, hashValid: false, signer: null, authorized: false, reason: 'signed for a different contract or session' };
  }
  const hashValid = declarationHash(declaration) === sig.contentHash;
  let signer = null;
  try { signer = ethers.verifyMessage(declarationMessage(contractAddress, session, sig.contentHash), sig.signature); }
  catch { return { at, signed: false, hashValid, signer: null, authorized: false, reason: 'signature does not recover' }; }
  const signed = eq(signer, sig.signer);
  let authorized = false;
  let reason;
  try { authorized = await contract.authorized(session, signer, ROLE_ADMIN); }
  catch (e) { reason = `the contract did not answer authorized(): ${e.shortMessage || e.message}`; }
  return { at, signed, hashValid, signer, authorized: authorized === true, ...(reason ? { reason } : {}) };
}

/** A declaration the contract stands behind: signed, current, and by an admin of the session. */
export function isVouched(facts) {
  return !!(facts?.signed && facts?.hashValid && facts?.authorized);
}
