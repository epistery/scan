/**
 * Guide — the answer when nothing scan holds matched: what scan is, and what
 * can be searched for. Derived from the handler registry itself, each kind
 * with a live example drawn from the index (a real indexed domain, a real
 * agent address, a topic a configured source declares), so the guide can
 * never advertise a kind of search that does not run or an example that
 * returns nothing.
 */
export async function guideFor(query, handlers, scan) {
  const searchable = [];
  for (const h of handlers) {
    if (h.available && !h.available(scan)) continue;
    let example = null;
    try { example = await h.example(scan); } catch { /* an example is optional */ }
    searchable.push({ kind: h.kind, describe: h.describe, example });
  }
  return {
    note: `Scan reports on entities with a known origin — it is not a general web search. Nothing it holds matched "${query}".`,
    searchable
  };
}
