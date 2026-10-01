/**
 * Posture — the signed signals an entity collects during its sync cycle.
 *
 * Scan reports FACTS with known origin, never a verdict: there is no score and
 * no label here. Each signal says whether it was observed and when; what they
 * add up to is the identity continuity rung (Present.mjs rungFromSignals), a
 * derived fact a surface renders — and the only summary this service offers.
 */

/**
 * Strip internal details from signals for API output.
 * Returns { signalName: { present, at }, ... }
 */
export function summarizeSignals(signals) {
  if (!signals) return {};
  const summary = {};
  for (const [name, signal] of Object.entries(signals)) {
    if (!signal) continue;
    summary[name] = { present: !!signal.present, at: signal.at || null };
  }
  return summary;
}
