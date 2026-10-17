/**
 * TextQuery — a query naming no entity is searched as text across what the
 * index holds: the knowledge text index over manifests, identities and
 * normalized objects; data source skills whose topics match; live capability
 * routing; a regex last resort; and the harness children's own results.
 *
 * Only declared text is searched. A question about the world that no origin
 * declared ("does the rain in spain…") finds nothing, and the guide explains
 * what can be searched instead.
 */
import { namesEntities } from './Intent.mjs';

export default {
  kind: 'text',
  describe: 'Words — matched against what signed origins declare: organization names, concepts, applications, people, identities, and the objects data sources publish',
  targets: (intent, scan) =>
    (namesEntities(intent) || (intent.service && scan.harness)) ? [] : [intent.raw],

  async run(q, scan, out, limit) {
    // Fire federated query in parallel (non-blocking until we need it)
    const childPromise = scan.harness
      ? scan.harness.query(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`)
      : Promise.resolve([]);

    // Text search — full-text across indexed manifests
    try {
      const textResults = await scan.db.collection('entities')
        .find({ $text: { $search: q } }, { score: { $meta: 'textScore' } })
        .sort({ score: { $meta: 'textScore' } })
        .limit(limit)
        .toArray();
      out.results.push(...(await scan._formatEntities(textResults)));
    } catch (err) {
      // Text index may not exist yet on empty DB — fall through to regex
      console.warn('[search] Text search failed, falling back to regex:', err.message);
    }

    // Skill orientation — match query to registered data source skills
    try {
      const skills = await scan._orientToSkills(q, limit);
      if (skills.length > 0) {
        out.results.push(...skills);
        out.meta.sources.push('skill-registry');
      }
    } catch (err) {
      console.warn('[search] Skill orientation failed:', err.message);
    }

    // Capability-based routing — check if any indexed source can handle this query live
    if (out.results.length === 0) {
      try {
        const capResults = await scan._queryCapableSources(q, limit);
        if (capResults.length > 0) {
          out.results.push(...capResults);
          out.meta.sources.push('capability-proxy');
        }
      } catch (err) {
        console.warn('[search] Capability routing failed:', err.message);
      }
    }

    // Fallback — regex search if text search yielded nothing
    if (out.results.length === 0) {
      const searchRegex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const entities = await scan.db.collection('entities')
        .find({
          $or: [
            { address: searchRegex },
            { 'metadata.manifest.organization.name': searchRegex },
            { 'metadata.manifest.organization.mission': searchRegex },
            { 'metadata.manifest.coreConcepts.term': searchRegex },
            { 'metadata.manifest.applications.name': searchRegex },
            { 'metadata.manifest.people.name': searchRegex },
            { 'metadata.domain': searchRegex },
            { 'metadata.app.name': searchRegex },
            { 'metadata.app.domain': searchRegex },
            { 'metadata.app.sessions.name': searchRegex }
          ]
        })
        .sort({ _modified: -1 })
        .limit(limit)
        .toArray();
      out.results.push(...(await scan._formatEntities(entities)));
    }

    // Merge federated results from harness children
    try {
      scan._mergeChildResults(out, await childPromise, limit);
    } catch (err) {
      console.warn('[search] Federated query failed:', err.message);
    }
  },

  // A topic a configured data source declares it answers — never a made-up word.
  async example(scan) {
    const topic = scan.ingestion?.domainDiscovery?.dataSources?.find(s => s.topics?.length)?.topics[0];
    if (topic) return topic;
    const e = await scan.db.collection('entities').findOne(
      { type: 'AIDiscovery', 'metadata.manifest.coreConcepts.term': { $exists: true } },
      { sort: { _modified: -1 }, projection: { 'metadata.manifest.coreConcepts': 1 } }
    );
    const c = e?.metadata?.manifest?.coreConcepts?.[0];
    return (c?.term || c) || null;
  }
};
