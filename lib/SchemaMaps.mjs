import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * SchemaMaps — the public category maps.
 *
 * Categories are cast as publicly defined JSON-LD maps (schema/*.json). A
 * source declares which schemas it resolves; each map declares how objects of
 * that schema are structured for search (title/summary/keywords), display
 * (image, card facets), and — reserved — trust factors. Scan projects structure
 * through these maps; it does not derive an ontology of its own. The maps are
 * served publicly at /api/schema so the projection is inspectable and, in time,
 * market-editable.
 *
 * Facet/summary entry: a bare dot-path string, or
 *   { path: "a.b" | ["a.b","c.d"], label, prefix, suffix, join, all }
 * Arrays encountered mid-path fan out; numbers are locale-formatted. Each
 * path contributes its FIRST resolved value unless `all: true`, which gathers
 * every value (an array-valued field like fuelTypes), joined by `join`.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = path.join(__dirname, '../schema');

const byKey = new Map();
const all = [];
for (const file of fs.readdirSync(SCHEMA_DIR).filter(f => f.endsWith('.json'))) {
  const map = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, file), 'utf8'));
  all.push(map);
  if (map.schema) byKey.set(map.schema, map);
  if (map.$id) byKey.set(map.$id, map);
  if (map.label) byKey.set(map.label.toLowerCase(), map);
}

export function allMaps() {
  return all;
}

/** Look up a map by schema IRI, $id, or label (case-insensitive). */
export function mapFor(schema) {
  if (!schema) return null;
  return byKey.get(schema) || byKey.get(String(schema).toLowerCase()) || null;
}

/** Resolve a dot-path against a JSON-LD object, fanning out over arrays. */
export function resolve(obj, dotPath) {
  let vals = [obj];
  for (const key of String(dotPath).split('.')) {
    const next = [];
    for (const v of vals) {
      if (v == null) continue;
      if (Array.isArray(v)) {
        for (const el of v) if (el?.[key] != null) next.push(el[key]);
      } else if (v[key] != null) {
        next.push(v[key]);
      }
    }
    vals = next;
  }
  return vals.flat();
}

function formatValue(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v.toLocaleString('en-US');
  return String(v).trim();
}

/** Evaluate one summary/facet entry against a JSON-LD object. Null when empty. */
function entryValue(jsonld, entry) {
  const spec = typeof entry === 'string' ? { path: entry } : entry;
  const paths = Array.isArray(spec.path) ? spec.path : [spec.path];
  const vals = paths
    .flatMap(p => spec.all ? resolve(jsonld, p) : [resolve(jsonld, p)[0]])
    .filter(v => v != null && String(v).trim() !== '')
    .map(formatValue);
  if (vals.length === 0) return null;
  return (spec.prefix || '') + vals.join(spec.join ?? ', ') + (spec.suffix || '');
}

/** Project the search digest — how this schema is structured for indexing. */
export function projectSearch(map, jsonld) {
  if (!map || !jsonld) return null;
  const search = map.search || {};
  let title = null;
  for (const p of search.title || ['name']) {
    const v = resolve(jsonld, p)[0];
    if (v != null && String(v).trim() !== '') { title = String(v).trim(); break; }
  }
  const summary = (search.summary || [])
    .map(entry => entryValue(jsonld, entry))
    .filter(Boolean)
    .join(' • ') || null;
  const keywords = (search.keywords || []).flatMap(p => resolve(jsonld, p));
  return { title, summary, keywords };
}

/**
 * Build a metadata.object digest from a JSON-LD projection — the one shape
 * every entity flavor (imported catalog object, contract-backed campaign /
 * identity / domain agent) stores so search and cards run through a single
 * path. Interpreters construct the jsonld; the public map does the rest.
 */
export function buildObjectDigest({ type, schema, jsonld, extraKeywords = [] }) {
  const map = mapFor(schema);
  const digest = map
    ? projectSearch(map, jsonld)
    : { title: jsonld.name || null, summary: jsonld.description || null, keywords: [jsonld.name] };
  const card = map ? projectCard(map, jsonld) : null;
  const tokens = (digest.keywords || []).flatMap(k =>
    String(k).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1)
  );
  return {
    type: type || map?.label?.toLowerCase() || 'object',
    schema: schema || null,
    title: digest.title || jsonld.name || null,
    summary: digest.summary || null,
    keywords: [...new Set([...tokens, ...extraKeywords])],
    jsonld,
    image: card?.image || null
  };
}

/** Project the display card — image and labeled facets. */
export function projectCard(map, jsonld) {
  if (!map || !jsonld) return null;
  const display = map.display || {};
  const image = display.image ? (resolve(jsonld, display.image)[0] || null) : null;
  const facets = (display.facets || [])
    .map(f => {
      const value = entryValue(jsonld, f);
      return value != null ? { label: f.label, value } : null;
    })
    .filter(Boolean);
  return { image, facets };
}
