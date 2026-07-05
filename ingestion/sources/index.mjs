import cars from './cars.mjs';
import politics from './politics.mjs';
import rental from './rental.mjs';
import { catalogEngine } from './jsonld.mjs';

/**
 * Registry of source import engines, keyed by the data source's config name
 * (the [datasources.<name>] INI key).
 *
 * Named engines are transitional adapters: they project a pre-standard
 * source's raw fields into JSON-LD. The standard path needs no entry here — a
 * source whose skill manifest declares a `catalog` of JSON-LD objects gets the
 * generic engine, and the public schema maps do the rest. Sources with neither
 * (e.g. `provenance`, an entity-lookup registry, or `shipping`, no listing
 * endpoint) are not bulk-indexed.
 */
const engines = {
  vehicles: cars,
  politics: politics,
  rentals: rental
};

export default engines;

/**
 * Engine for a data source: a named adapter if one exists, else the generic
 * JSON-LD engine when the source's skill manifest declares a catalog.
 */
export function engineFor(name, skillManifest) {
  if (engines[name]) return engines[name];
  if (skillManifest?.catalog) return catalogEngine(skillManifest.catalog);
  return null;
}
