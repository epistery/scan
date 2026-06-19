import { compact, keywords } from './util.mjs';

/**
 * Cars Rootz import engine — used-vehicle listings.
 *
 * Catalog at GET /api/search (paginated limit/offset; the free-text `q` param
 * is ignored by the source, so we page the full inventory). Objects are keyed
 * by VIN. The author's listing fields are preserved verbatim under metadata.fields.
 */
export default {
  objectType: 'vehicle',
  objectsKey: 'vehicles',
  pageSize: 500,
  listUrl: (base, offset, limit) => `${base}/api/search?limit=${limit}&offset=${offset}`,
  total: (resp) => resp?.total ?? 0,
  id: (o) => o.vin,
  map: (o, base) => ({
    title: compact([o.year, o.make, o.model, o.trim]) || `Vehicle ${o.vin}`,
    summary: compact([
      o.body_type,
      o.mileage != null ? `${o.mileage} mi` : null,
      o.price != null ? `$${o.price}` : null,
      o.fuel_type,
      compact([o.dealer_name, compact([o.dealer_city, o.dealer_state], ', ')], ' — ')
    ], ' • '),
    keywords: keywords(
      o.make, o.model, o.trim, o.body_type, o.fuel_type, o.exterior_color,
      o.year, o.dealer_name, o.dealer_city, o.dealer_state,
      'vehicle', 'car', 'used'
    ),
    url: o.listing_url || `${base}/api/vehicle/${o.vin}`
  })
};
