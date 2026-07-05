import { compact, prune } from './util.mjs';

/**
 * Politics Rootz adapter — US elected officials and candidates.
 *
 * Transitional: projects the source's raw fields into schema.org/Person
 * JSON-LD. Search digest and display card come from the public schema map
 * (schema/Person.json). Retires when politics.rootz.global serves JSON-LD
 * natively.
 *
 * Catalog at GET /api/search (paginated limit/offset). Objects keyed by
 * bioguide_id, then fec id, then the source's numeric id.
 */
export default {
  objectType: 'official',
  schema: 'https://schema.org/Person',
  objectsKey: 'officials',
  pageSize: 500,
  listUrl: (base, offset, limit) => `${base}/api/search?limit=${limit}&offset=${offset}`,
  total: (resp) => resp?.total ?? 0,
  id: (o) => o.bioguide_id || o.fec_candidate_id || (o.id != null ? `id-${o.id}` : null),
  jsonld: (o) => {
    const district = o.district ? compact([o.state, o.district], '-') : o.state;
    return prune({
      '@context': 'https://schema.org',
      '@type': 'Person',
      name: o.name || compact([o.first_name, o.last_name]) || null,
      givenName: o.first_name,
      familyName: o.last_name,
      image: o.photo_url,
      jobTitle: compact([o.office_name || o.office_chamber || o.branch, district], ', ') || null,
      memberOf: o.party ? { '@type': 'Organization', name: o.party } : null,
      address: (o.state || o.city) ? prune({
        '@type': 'PostalAddress',
        addressLocality: o.city,
        addressRegion: o.state
      }) : null,
      description: o.status,
      identifier: o.bioguide_id || o.fec_candidate_id,
      sameAs: [o.social_twitter, o.social_facebook].filter(Boolean),
      url: o.website || o.campaign_url
    });
  }
};
