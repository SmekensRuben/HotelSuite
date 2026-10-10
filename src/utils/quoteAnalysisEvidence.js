export const CONTRIBUTION_SNAPSHOT_VERSION = "group-quote-contribution-snapshot-v2";

// Preserve calculated inputs and portfolios without retaining mutable references.
// Unknown numbers remain unknown instead of becoming an apparent zero.
export function freezeContributionEvidence(contribution) {
  if (!contribution || contribution.validationError) return null;
  const { losNetworkDisplacement: _los, legacyStayDateDisplacement: _legacy, ...evidence } = contribution;
  return JSON.parse(JSON.stringify({ snapshotVersion: CONTRIBUTION_SNAPSHOT_VERSION, ...evidence },
    (_key, value) => typeof value === "number" && !Number.isFinite(value) ? null : value));
}

export function losAnalysisFallback(modelVersion, reason, details = {}) {
  return { modelVersion, active: false, warningCode: "LOS_NETWORK_FALLBACK_TO_STAY_DATE", fallbackReason: reason, ...details };
}
