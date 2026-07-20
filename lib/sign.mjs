import crypto from 'crypto';

/**
 * Sign a JSON response for provenance: sha256 of the canonical JSON, signed
 * by scan's own key, attached as `signed: { hash, signature, signer }`.
 * The one signing shape for every scan surface (search, standing); consumers
 * verify by re-hashing the response minus `signed` and recovering the signer.
 * No signer (or a signer error) returns the response unsigned — signing is
 * provenance, never a gate.
 */
export async function signResponse(response, signer) {
  if (!signer) return response;
  try {
    const canonical = JSON.stringify(response);
    const hash = crypto.createHash('sha256').update(canonical).digest('hex');
    const signature = await signer.signMessage(hash);
    const address = await signer.getAddress();
    return { ...response, signed: { hash, signature, signer: address } };
  } catch {
    return response;
  }
}
