import cars from './cars.mjs';
import politics from './politics.mjs';
import rental from './rental.mjs';

/**
 * Registry of source import engines, keyed by the data source's config name
 * (the [datasources.<name>] INI key). A data source without an engine here is
 * not bulk-indexed — e.g. `provenance` (origin) is an entity-lookup registry,
 * not a catalog, and `shipping` exposes no listing endpoint.
 */
const engines = {
  vehicles: cars,
  politics: politics,
  rentals: rental
};

export default engines;

/** Engine for a data source name, or null if that source has no import engine. */
export function engineFor(name) {
  return engines[name] || null;
}
