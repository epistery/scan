import { compact, keywords } from './util.mjs';

/**
 * Rental Rootz import engine — Caribbean vacation rental properties.
 *
 * Catalog at GET /api/search (paginated limit/offset). Objects keyed by RIN.
 * Author fields preserved under metadata.fields.
 */
export default {
  objectType: 'property',
  objectsKey: 'properties',
  pageSize: 500,
  listUrl: (base, offset, limit) => `${base}/api/search?limit=${limit}&offset=${offset}`,
  total: (resp) => resp?.total ?? 0,
  id: (o) => o.rin,
  map: (o, base) => ({
    title: o.name || compact([o.property_type, 'in', o.island || o.country_name]) || `Property ${o.rin}`,
    summary: compact([
      o.property_type,
      o.bedrooms != null ? `${o.bedrooms}BR` : null,
      o.sleeps != null ? `sleeps ${o.sleeps}` : null,
      compact([o.region, o.island, o.country_name], ', ')
    ], ' • '),
    keywords: keywords(
      o.name, o.property_type, o.country_name, o.island, o.region,
      o.amenities,
      'rental', 'vacation', 'property', 'caribbean'
    ),
    url: `${base}/api/property/${o.rin}`
  })
};
