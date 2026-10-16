import { describe, expect, it } from "vitest";
import { stagingReleaseState } from "./stagingRelease";

describe("staging release readiness", () => {
  const sha = "a".repeat(40);
  const ready = { state: "ready", sha, frontendSha: sha, backendSha: sha };
  it("opens only a matching completed release", () => {
    expect(stagingReleaseState(ready, sha)).toBe("ready");
    for (const field of ["sha", "frontendSha", "backendSha"]) {
      expect(stagingReleaseState({ ...ready, [field]: "b".repeat(40) }, sha)).toBe("version-mismatch");
      expect(stagingReleaseState({ ...ready, [field]: undefined }, sha)).toBe("version-mismatch");
    }
  });
  it("blocks missing metadata, incomplete deployment and unidentified builds", () => {
    expect(stagingReleaseState(undefined, sha)).toBe("unavailable");
    expect(stagingReleaseState({ ...ready, state: "deploying" }, sha)).toBe("unavailable");
    expect(stagingReleaseState(ready, "")).toBe("invalid-build");
  });
});
