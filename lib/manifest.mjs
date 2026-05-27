import crypto from 'crypto';

/**
 * Canonical manifest hashing — the integrity check behind the `hashValid`
 * trust signal. Mirrors DomainDiscovery.collectSignals exactly: strip the
 * `_signature` block and the volatile `generated` timestamp, recursively sort
 * keys, JSON.stringify, SHA-256. Returned with the `sha256:` prefix to match
 * the AI Discovery Standard's `_signature.contentHash`.
 */
export function sortKeys(obj) {
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (obj && typeof obj === 'object') {
    return Object.keys(obj).sort().reduce((s, k) => { s[k] = sortKeys(obj[k]); return s; }, {});
  }
  return obj;
}

export function manifestContentHash(manifest) {
  const clone = JSON.parse(JSON.stringify(manifest));
  delete clone._signature;
  delete clone.generated;
  const canonical = JSON.stringify(sortKeys(clone));
  return 'sha256:' + crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * True when the manifest's declared contentHash matches what we recompute.
 */
export function verifyManifestHash(manifest) {
  const declared = manifest?._signature?.contentHash;
  if (!declared) return false;
  return manifestContentHash(manifest) === declared;
}
