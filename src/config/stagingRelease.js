export function stagingReleaseState(release, expectedSha) {
  if (!/^[a-f0-9]{40}$/.test(expectedSha || "")) return "invalid-build";
  if (!release || release.state !== "ready") return "unavailable";
  return release.sha === expectedSha && release.backendSha === expectedSha && release.frontendSha === expectedSha
    ? "ready" : "version-mismatch";
}
