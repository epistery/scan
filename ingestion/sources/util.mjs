/**
 * Shared helpers for source import engines.
 *
 * Each engine maps a source's raw object into a normalized shape. These keep
 * the title/summary/keyword building consistent across engines without forcing
 * every engine to reimplement string juggling.
 */

/** Join truthy parts with a separator, trimming blanks. */
export function compact(parts, sep = ' ') {
  return parts.map(p => (p == null ? '' : String(p).trim())).filter(Boolean).join(sep);
}

/**
 * Build a deduped, lowercased keyword list from arbitrary parts.
 * Flattens arrays, splits on word boundaries, drops blanks and 1-char tokens.
 */
export function keywords(...parts) {
  const out = new Set();
  const push = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) return v.forEach(push);
    String(v).toLowerCase().split(/[^a-z0-9]+/).forEach(tok => {
      if (tok.length > 1) out.add(tok);
    });
  };
  parts.forEach(push);
  return [...out];
}
