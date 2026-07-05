/**
 * Generic JSON-LD catalog engine — the standard path.
 *
 * A source that serves a paged catalog of JSON-LD objects needs no adapter in
 * this repo: its skill manifest declares the catalog, the object's @type names
 * the public schema, and the schema map (schema/*.json, served at /api/schema)
 * drives search and display. The author's object is stored verbatim — for a
 * native JSON-LD source, metadata.fields IS the declaration.
 *
 * Skill manifest declaration (at /.well-known/ai/skill.json):
 *   "catalog": {
 *     "path": "/api/catalog?limit={limit}&offset={offset}",
 *     "objectsKey": "items",      // default "items"
 *     "pageSize": 500             // optional
 *   }
 *
 * Objects are keyed by @id or identifier and typed by @type (bare names
 * resolve against schema.org).
 */
export function catalogEngine(catalog = {}) {
  return {
    objectType: null, // derived from the schema map's label at normalize time
    objectsKey: catalog.objectsKey || 'items',
    pageSize: catalog.pageSize || 500,
    listUrl: (base, offset, limit) => {
      const p = String(catalog.path || '/api/catalog?limit={limit}&offset={offset}')
        .replace('{limit}', limit)
        .replace('{offset}', offset);
      return /^https?:/.test(p) ? p : `${base}${p}`;
    },
    total: (resp) => resp?.total ?? 0,
    id: (o) => o?.['@id'] || o?.identifier || null,
    schemaOf: (o) => {
      const t = Array.isArray(o?.['@type']) ? o['@type'][0] : o?.['@type'];
      if (!t) return null;
      return /^https?:/.test(t) ? t : `https://schema.org/${t}`;
    },
    jsonld: (o) => o
  };
}
