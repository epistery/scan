/**
 * DNS probe — the records a domain publishes about itself, read now.
 *
 * Reported as observations, not judged: whether the name resolves, the _ai
 * TXT delegation (the AI Discovery record), mail exchangers, SPF, DMARC
 * policy, CAA (which authorities may issue its certificates) and name servers.
 * Only _ai bears on the rung, and only through discovery's own dnsVerified
 * signal; the rest are facts a reader weighs.
 */
import dns from 'dns';

const resolver = new dns.promises.Resolver({ timeout: 2000, tries: 1 });

// A missing record is an answer (null), anything else is the error's code.
async function read(fn) {
  try {
    return { value: await fn() };
  } catch (err) {
    if (err.code === 'ENODATA' || err.code === 'ENOTFOUND') return { value: null };
    return { value: null, error: err.code || err.message };
  }
}

const txt = (records) => records.map(r => r.join(''));

export async function probeDns(host) {
  const [a, aaaa, ai, mx, root, dmarc, caa, ns] = await Promise.all([
    read(() => resolver.resolve4(host)),
    read(() => resolver.resolve6(host)),
    // only an AI Discovery record — a wildcard zone answers _ai with anything (a parked domain's SPF)
    read(async () => txt(await resolver.resolveTxt(`_ai.${host}`)).find(t => /^v=aid1\b/i.test(t)) || null),
    read(async () => (await resolver.resolveMx(host)).sort((x, y) => x.priority - y.priority).map(m => m.exchange)),
    read(async () => txt(await resolver.resolveTxt(host))),
    read(async () => txt(await resolver.resolveTxt(`_dmarc.${host}`)).find(t => /^v=DMARC1/i.test(t)) || null),
    read(async () => (await resolver.resolveCaa(host)).filter(c => c.issue || c.issuewild).map(c => c.issue || c.issuewild)),
    read(() => resolver.resolveNs(host))
  ]);
  const addresses = [...(a.value || []), ...(aaaa.value || [])];
  const failed = [a, aaaa].every(r => r.error) ? (a.error || aaaa.error) : null;
  return {
    at: new Date(),
    resolves: addresses.length > 0,
    addresses,
    error: failed,
    ai: ai.value || null,
    mx: mx.value?.length ? mx.value : null,
    spf: (root.value || []).find(t => /^v=spf1/i.test(t)) || null,
    dmarc: dmarc.value || null,
    caa: caa.value?.length ? [...new Set(caa.value)] : null,
    ns: ns.value?.length ? ns.value : null
  };
}
