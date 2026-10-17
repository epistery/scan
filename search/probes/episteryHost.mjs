/**
 * Epistery host probe — /.well-known/epistery, read now.
 *
 * An epistery host announces its server (domain) wallet and chain there. When
 * scan also indexes the domain's agent contract, the contract names the host
 * wallet it bound — the two read from opposite sides, and whether they agree
 * is reported as a fact.
 */
import { WELL_KNOWN_PATH } from 'epistery';

export async function probeEpisteryHost(host, { timeout = 3000 } = {}) {
  const at = new Date();
  const url = `https://${host}${WELL_KNOWN_PATH}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return { at, url, present: false, status: res.status };
    const body = await res.json();
    const wallet = body?.server?.walletAddress || null;
    if (!wallet) return { at, url, present: false, status: res.status };
    return { at, url, present: true, wallet, chainId: body.server.chainId || null, provider: body.server.provider || null };
  } catch (err) {
    return { at, url, present: false, error: err.name === 'TimeoutError' ? 'timeout' : (err.cause?.code || err.message) };
  }
}
