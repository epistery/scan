/**
 * AddressQuery — a query naming a chain address (0x…): every indexed entity
 * the address is, owns, hosts or signed for, plus a live read on each
 * configured chain the index did not already answer for.
 */
export default {
  kind: 'address',
  describe: 'A chain address (0x…) — the identities, domain agents and campaigns indexed under it, and its live state on each configured chain',
  targets: (intent) => intent.addresses,

  async run(address, scan, out) {
    const addrRegex = new RegExp(`^${address}$`, 'i');
    const entities = await scan.db.collection('entities').find({
      $or: [
        { address: addrRegex },
        { 'metadata.owner': addrRegex },
        { 'metadata.host': addrRegex },
        { 'metadata.verification.digitalName': addrRegex },
        { 'metadata.manifest._signature.digitalName': addrRegex },
        { 'metadata.identityLinks.address': addrRegex },
        { 'metadata.app.owner': addrRegex }
      ]
    }).limit(20).toArray();
    out.results.push(...(await scan._formatEntities(entities)));

    // Chains already answered by a stored entity for this exact address —
    // the indexed row (campaign, identity, …) IS that chain's result; a
    // second live-RPC row for the same contract is a duplicate.
    const coveredChains = new Set(
      entities.filter(e => addrRegex.test(e.address) && e.chain).map(e => e.chain)
    );

    // Live chain query — runs in parallel across all configured chains
    if (!scan.ingestion?.connectors) return;
    try {
      const chainResults = (await scan.queryChainForAddress(address))
        .filter(cr => !coveredChains.has(cr.chain));
      for (const cr of chainResults) out.results.push(scan.formatWalletResult(address, cr));
      if (chainResults.length > 0) {
        if (!out.meta.sources.includes('live-rpc')) out.meta.sources.push('live-rpc');
        // Background index for future lookups
        scan._backgroundIndexAddress(address, chainResults).catch(e =>
          console.warn('[search] Background index failed:', e.message)
        );
      }
    } catch (err) {
      console.warn('[search] Chain query failed:', err.message);
    }
  },

  async example(scan) {
    const e = await scan.db.collection('entities')
      .findOne({ type: 'Agent' }, { sort: { _modified: -1 }, projection: { address: 1 } });
    return e?.address || null;
  }
};
