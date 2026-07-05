import { compact, prune } from './util.mjs';

/**
 * Cars Rootz adapter — used-vehicle listings.
 *
 * Transitional: projects the source's raw listing fields into
 * schema.org/Vehicle JSON-LD. Search digest and display card come from the
 * public schema map (schema/Vehicle.json). Retires when cars.rootz.global
 * serves the catalog as JSON-LD natively (then the generic engine applies and
 * the author's declaration is stored verbatim).
 *
 * Catalog at GET /api/search (paginated limit/offset). Objects keyed by VIN.
 * Raw author fields preserved under metadata.fields regardless.
 */
export default {
  objectType: 'vehicle',
  schema: 'https://schema.org/Vehicle',
  objectsKey: 'vehicles',
  pageSize: 500,
  listUrl: (base, offset, limit) => `${base}/api/search?limit=${limit}&offset=${offset}`,
  total: (resp) => resp?.total ?? 0,
  id: (o) => o.vin,
  jsonld: (o, base) => prune({
    '@context': 'https://schema.org',
    '@type': 'Vehicle',
    name: compact([o.year, o.make, o.model, o.trim]) || `Vehicle ${o.vin}`,
    vehicleIdentificationNumber: o.vin,
    brand: o.make ? { '@type': 'Brand', name: o.make } : null,
    model: o.model,
    vehicleModelDate: o.year,
    bodyType: o.body_type,
    fuelType: o.fuel_type,
    color: o.exterior_color,
    vehicleTransmission: o.transmission,
    driveWheelConfiguration: o.drivetrain,
    mileageFromOdometer: o.mileage != null
      ? { '@type': 'QuantitativeValue', value: o.mileage, unitCode: 'SMI' }
      : null,
    offers: (o.price != null || o.dealer_name) ? prune({
      '@type': 'Offer',
      price: o.price,
      priceCurrency: 'USD',
      seller: o.dealer_name ? prune({
        '@type': 'AutoDealer',
        name: o.dealer_name,
        address: prune({
          '@type': 'PostalAddress',
          addressLocality: o.dealer_city,
          addressRegion: o.dealer_state,
          postalCode: o.dealer_zip
        })
      }) : null
    }) : null,
    url: o.listing_url || `${base}/vehicle/${o.vin}`
  })
};
