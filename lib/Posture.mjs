/**
 * Posture — Signal-based trust scoring
 *
 * Each entity collects independent trust signals during its sync cycle.
 * Trust score = sum of weights for signals where present === true.
 */

export const SIGNAL_WEIGHTS = {
  manifest:         10,   // Domain publishes structured AI data
  selfSigned:       15,   // Ownership assertion via _signature
  hashValid:        10,   // Content integrity since signing
  contractExists:   20,   // Signing identity has on-chain contract
  domainBinding:    25,   // Bidirectional domain-contract reference
  dnsVerified:      10,   // DNS owner authorized AI discovery
  platform:         10,   // Runs on known platform (epistery-host)
  dkimSigned:       15,   // Domain mail key signed manifest (future)
  challengeProven:  20    // Wallet holder proved live control (future)
};

/**
 * Compute trust score from a signals object.
 * @param {Object} signals - { signalName: { present: boolean, ... }, ... }
 * @returns {number} integer trust score
 */
export function computeTrustScore(signals) {
  if (!signals) return 0;
  let score = 0;
  for (const [name, signal] of Object.entries(signals)) {
    if (signal?.present && SIGNAL_WEIGHTS[name]) {
      score += SIGNAL_WEIGHTS[name];
    }
  }
  return score;
}

/**
 * Strip internal details from signals for API output.
 * Returns { signalName: { present, at }, ... }
 */
export function summarizeSignals(signals) {
  if (!signals) return {};
  const summary = {};
  for (const [name, signal] of Object.entries(signals)) {
    if (!signal) continue;
    summary[name] = {
      present: !!signal.present,
      at: signal.at || null
    };
  }
  return summary;
}

/**
 * Map trust score to UI threshold label.
 * Used server-side for stats; UI also has its own copy.
 */
export function trustLabel(score) {
  if (score >= 75) return 'Verified';
  if (score >= 50) return 'Trusted';
  if (score >= 25) return 'Claimed';
  if (score >= 1)  return 'Discovered';
  return 'Open';
}
