import { prune } from './util.mjs';

/**
 * Rental Rootz adapter — Caribbean vacation rental properties.
 *
 * Transitional: projects the source's raw property fields into
 * schema.org/VacationRental JSON-LD. Search digest and display card come from
 * the public schema map (schema/VacationRental.json). Retires when
 * rental.rootz.global serves JSON-LD natively.
 *
 * Catalog at GET /api/search (paginated limit/offset). Objects keyed by RIN.
 */
export default {
  objectType: 'property',
  schema: 'https://schema.org/VacationRental',
  objectsKey: 'properties',
  pageSize: 500,
  listUrl: (base, offset, limit) => `${base}/api/search?limit=${limit}&offset=${offset}`,
  total: (resp) => resp?.total ?? 0,
  id: (o) => o.rin,
  jsonld: (o, base) => prune({
    '@context': 'https://schema.org',
    '@type': 'VacationRental',
    name: o.name || null,
    identifier: o.rin,
    accommodationCategory: o.property_type,
    image: (o.photos || []).slice(0, 8),
    numberOfBedrooms: o.bedrooms,
    numberOfBathroomsTotal: o.bathrooms,
    occupancy: o.sleeps != null ? { '@type': 'QuantitativeValue', value: o.sleeps } : null,
    floorSize: o.sqft != null ? { '@type': 'QuantitativeValue', value: o.sqft, unitCode: 'FTK' } : null,
    description: o.description,
    address: prune({
      '@type': 'PostalAddress',
      addressLocality: o.region,
      addressRegion: o.island,
      addressCountry: o.country_name
    }),
    geo: (o.lat != null && o.lng != null)
      ? { '@type': 'GeoCoordinates', latitude: o.lat, longitude: o.lng }
      : null,
    amenityFeature: (o.amenities || []).map(a => ({ '@type': 'LocationFeatureSpecification', name: a })),
    priceRange: o.rate_avg != null ? `$${o.rate_avg}/night`
      : (o.rate_low != null ? `$${o.rate_low}–$${o.rate_high ?? o.rate_low}/night` : null),
    aggregateRating: o.best_rating
      ? { '@type': 'AggregateRating', ratingValue: o.best_rating, reviewCount: o.total_reviews || 0 }
      : null,
    url: `${base}/api/property/${o.rin}`
  })
};
