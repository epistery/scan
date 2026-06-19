import { compact, keywords } from './util.mjs';

/**
 * Politics Rootz import engine — US elected officials and candidates.
 *
 * Catalog at GET /api/search (paginated limit/offset; honors `q` but we page
 * the full set for indexing). Objects keyed by bioguide_id, then fec id, then
 * the source's numeric id. Author fields preserved under metadata.fields.
 */
export default {
  objectType: 'official',
  objectsKey: 'officials',
  pageSize: 500,
  listUrl: (base, offset, limit) => `${base}/api/search?limit=${limit}&offset=${offset}`,
  total: (resp) => resp?.total ?? 0,
  id: (o) => o.bioguide_id || o.fec_candidate_id || (o.id != null ? `id-${o.id}` : null),
  map: (o, base) => ({
    title: o.name || compact([o.first_name, o.last_name]) || `Official ${o.id ?? ''}`.trim(),
    summary: compact([
      o.party,
      o.status,
      o.office_name || o.office_chamber || o.branch,
      compact([o.state, o.district], '-')
    ], ' • '),
    keywords: keywords(
      o.name, o.first_name, o.last_name, o.party, o.state,
      o.office_name, o.office_chamber, o.branch, o.level,
      'politician', 'official', 'candidate', 'government'
    ),
    url: o.website || o.campaign_url || null
  })
};
