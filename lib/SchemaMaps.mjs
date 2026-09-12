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
 *   { path: "a.b" | ["a.b","c.d"], label, prefix, suffix, join, all, format }
 * Arrays encountered mid-path fan out; numbers are locale-formatted. Each
 * path contributes its FIRST resolved value unless `all: true`, which gathers
 * every value (an array-valued field like fuelTypes), joined by `join`.
 * `format: "plain"` suppresses locale formatting for numbers that are labels
 * rather than quantities — a year, a use code, a parcel id — which would
 * otherwise render with a thousands separator ("2,011" for yearEstablished).
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

const _esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * The self-describing DEFINITION of a type — what an unfamiliar AI gets when it
 * dereferences the @type IRI. This is NOT the category map (scan's projection at
 * /api/schema); it is the vocabulary term: the type, its identity rule, and each
 * field's meaning and datatype. Served as JSON-LD so it is linked-data native.
 *
 * A type that has not yet been given an authored `fields` contract still resolves
 * to something honest — bare field names derived from its display facets — rather
 * than a 404 or a page that merely says the URL exists.
 */
export function schemaDefinition(map) {
  const fields = Array.isArray(map.fields) && map.fields.length
    ? map.fields
    : (map.display?.facets || []).map((f) => ({
        name: Array.isArray(f.path) ? f.path[0] : f.path,
        type: 'string',
        description: f.label,
        derived: true
      }));
  return {
    '@context': {
      rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
      epistery: 'https://epistery.com/schema/',
      label: 'rdfs:label',
      description: 'rdfs:comment',
      fields: 'epistery:fields',
      identity: 'epistery:identity'
    },
    '@id': map.$id || map.schema,
    '@type': 'rdfs:Class',
    label: map.label,
    version: map.version,
    description: map.description,
    identity: map.identity || null,
    fields,
    categoryMap: `/api/schema/${map.label}`
  };
}

/**
 * The human view of the same definition — plain HTML, no framework, same house
 * style as the rest of scan. A browser gets this; a machine gets schemaDefinition.
 */
export function renderSchemaHtml(map) {
  const def = schemaDefinition(map);
  const typeStr = (f) => {
    let t = f.type === 'array'
      ? 'array' + (f.items ? ' of ' + _esc(JSON.stringify(f.items)) : '')
      : _esc(f.type || 'string');
    if (f.unit) t += ` <span class="unit">(${_esc(f.unit)})</span>`;
    return t;
  };
  const rows = def.fields.map((f) => {
    const ex = f.example !== undefined
      ? `<div class="ex">e.g. <code>${_esc(typeof f.example === 'object' ? JSON.stringify(f.example) : f.example)}</code></div>`
      : '';
    const tags = `${f.identity ? ' <span class="tag id">identity</span>' : ''}${f.optional ? ' <span class="tag opt">optional</span>' : ''}`;
    return `<tr><td><code>${_esc(f.name)}</code>${tags}</td><td>${typeStr(f)}</td><td>${_esc(f.description || '')}${ex}</td></tr>`;
  }).join('');
  const idNote = def.identity
    ? `<p class="idnote">Each object's <code>@id</code> is <code>${_esc(def.identity.pattern || def.identity.field)}</code>.${def.identity.note ? ' ' + _esc(def.identity.note) : ''}</p>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${_esc(map.label)} — Epistery schema</title>
<style>
  body{font:16px/1.6 system-ui,sans-serif;max-width:820px;margin:2.5rem auto;padding:0 1.25rem;color:#1a1a1a}
  h1{margin:0 0 .25rem;font-size:1.6rem} h2{font-size:1.05rem;margin:1.75rem 0 .5rem}
  .iri{color:#666;font-size:.9rem;word-break:break-all}
  .desc{margin:1.25rem 0;font-size:1.05rem} .idnote{color:#444;font-size:.95rem}
  table{border-collapse:collapse;width:100%} th{text-align:left;font-size:.8rem;color:#888;text-transform:uppercase;letter-spacing:.03em;padding:.3rem .6rem;border-bottom:2px solid #eee}
  td{padding:.5rem .6rem;border-bottom:1px solid #eee;vertical-align:top} td:first-child{white-space:nowrap}
  code{background:#f4f4f4;padding:.05rem .35rem;border-radius:3px;font-size:.9em}
  .ex{color:#666;font-size:.85rem;margin-top:.2rem} .unit{color:#888;font-size:.85em}
  .tag{font-size:.7rem;text-transform:uppercase;letter-spacing:.03em;padding:.05rem .35rem;border-radius:3px;vertical-align:middle}
  .tag.id{background:#e7f0ff;color:#0645ad} .tag.opt{background:#f0f0f0;color:#888}
  .foot{color:#666;font-size:.9rem;margin-top:2rem;border-top:1px solid #eee;padding-top:1rem} a{color:#0645ad}
</style></head><body>
<h1>${_esc(map.label)}</h1>
<div class="iri">${_esc(map.$id || map.schema)}</div>
<p class="desc">${_esc(map.description || '')}</p>
${idNote}
<h2>Fields</h2>
<table><thead><tr><th>Field</th><th>Type</th><th>Meaning</th></tr></thead><tbody>${rows || '<tr><td colspan="3">No fields declared.</td></tr>'}</tbody></table>
<p class="foot">An epistery-published type. Objects declare it as their <code>@type</code> and are
identified by their <code>@id</code>. This is the human view; request the same URL with
<code>Accept: application/json</code> for the machine-readable (JSON-LD) definition. How
Epistery&nbsp;Scan projects objects of this type for search and display is a separate,
implementation detail at <a href="/api/schema/${_esc(map.label)}">/api/schema/${_esc(map.label)}</a>.
See <a href="/api/schema">/api/schema</a> for every published type.</p>
</body></html>`;
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

function formatValue(v, format) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return format === 'plain' ? String(v) : v.toLocaleString('en-US');
  }
  return String(v).trim();
}

/** Evaluate one summary/facet entry against a JSON-LD object. Null when empty. */
function entryValue(jsonld, entry) {
  const spec = typeof entry === 'string' ? { path: entry } : entry;
  const paths = Array.isArray(spec.path) ? spec.path : [spec.path];
  const vals = paths
    .flatMap(p => spec.all ? resolve(jsonld, p) : [resolve(jsonld, p)[0]])
    .filter(v => v != null && String(v).trim() !== '')
    .map(v => formatValue(v, spec.format));
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
