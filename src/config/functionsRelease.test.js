import { describe, expect, it } from "vitest";
import { requireFunctionsConfiguration, requireFunctionsRelease, FUNCTIONS_PROVIDER, FUNCTIONS_DEPLOY_ACCOUNT } from "../../scripts/firebase/functions-release-policy.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sha = "a".repeat(40);
const verified = { name: "Verify HotelSuite", head_sha: sha, head_branch: "main", event: "push", status: "completed", conclusion: "success",
  head_repository: { id: 1161047380, full_name: "SmekensRuben/HotelSuite" } };
const release = () => ({ eventName: "workflow_run", event: { workflow_run: structuredClone(verified) }, repository: "SmekensRuben/HotelSuite",
  ref: "refs/heads/main", checkedOutSha: sha, mainSha: sha, verifiedRuns: [structuredClone(verified)] });
const env = () => ({ FIREBASE_PROJECT_ID: "hotel-toolkit", FIREBASE_WORKLOAD_IDENTITY_PROVIDER: FUNCTIONS_PROVIDER,
  FIREBASE_DEPLOY_SERVICE_ACCOUNT: FUNCTIONS_DEPLOY_ACCOUNT, FUNCTIONS_APP_BASE_URL: "https://hotel-suite-neon.vercel.app" });

describe("Functions release authorization", () => {
  it("allows a successful push verification for the exact current main commit", () => expect(requireFunctionsRelease(release())).toBe(true));
  it("skips an older queued release", () => expect(requireFunctionsRelease({ ...release(), mainSha: "b".repeat(40) })).toBe(false));
  it("allows recovery dispatch only with successful push verification of main", () => expect(requireFunctionsRelease({ ...release(), eventName: "workflow_dispatch", event: {} })).toBe(true));
  it.each(["pull_request", "pull_request_target", "push"])("rejects unsupported %s events", eventName => expect(() => requireFunctionsRelease({ ...release(), eventName })).toThrow());
  it.each([
    ["event", "pull_request"], ["conclusion", "failure"], ["status", "in_progress"], ["head_branch", "feature"],
    ["head_sha", "b".repeat(40)], ["name", "Unrelated check"], ["head_repository", { id: 12, full_name: "SmekensRuben/HotelSuite" }],
  ])("rejects an unsafe verification run with %s changed", (key, value) => {
    const input = release(); input.event.workflow_run[key] = value;
    expect(() => requireFunctionsRelease(input)).toThrow();
  });
  it("rejects manually dispatched feature branches", () => expect(() => requireFunctionsRelease({ ...release(), eventName: "workflow_dispatch", ref: "refs/heads/feature" })).toThrow());
  it("rejects a copied repository", () => expect(() => requireFunctionsRelease({ ...release(), repository: "another/HotelSuite" })).toThrow());
  it("requires a successful run from the verification workflow", () => expect(() => requireFunctionsRelease({ ...release(), verifiedRuns: [] })).toThrow());
  it("rejects a successful PR run as evidence for a manual release", () => {
    expect(() => requireFunctionsRelease({ ...release(), eventName: "workflow_dispatch", verifiedRuns: [{ ...verified, event: "pull_request" }] })).toThrow();
  });
});

describe("Functions environment authorization", () => {
  it("accepts the reviewed keyless production identity and public HTTPS origin", () => expect(requireFunctionsConfiguration(env())).toBe("https://hotel-suite-neon.vercel.app"));
  it.each(["FIREBASE_PROJECT_ID", "FIREBASE_WORKLOAD_IDENTITY_PROVIDER", "FIREBASE_DEPLOY_SERVICE_ACCOUNT"])("rejects missing or different %s", key => {
    expect(() => requireFunctionsConfiguration({ ...env(), [key]: "different" })).toThrow();
  });
  it.each(["http://example.com", "https://user:password@example.com", "https://example.com/path", "https://example.com?x=y", "https://example.com#fragment", "https://example.com\nAPP_BASE_URL=other", "https://localhost", ""])("rejects unsafe APP_BASE_URL %s", value => {
    expect(() => requireFunctionsConfiguration({ ...env(), FUNCTIONS_APP_BASE_URL: value })).toThrow();
  });
});

describe("Cloud Shell setup boundaries", () => {
  it("uses the verified Storage identity even when gcloud prints an indented address", () => {
    const directory = mkdtempSync(join(tmpdir(), "hotelsuite-storage-"));
    try {
      const calls = join(directory, "calls.jsonl");
      writeFileSync(join(directory, "gcloud"), `#!/bin/bash
case "$*" in
  "projects describe hotel-toolkit --format=value(projectNumber)") echo 358734544002 ;;
  "auth list "*) echo operator@example.com ;;
  "builds get-default-service-account "*) echo 358734544002-compute@developer.gserviceaccount.com ;;
  "storage service-agent "*) printf '\\n  service-358734544002@gs-project-accounts.iam.gserviceaccount.com\\n' ;;
  "secrets versions describe "*) echo ENABLED ;;
  "projects add-iam-policy-binding "*)
    for argument in "$@"; do
      if [[ "$argument" == --member=* ]] && [[ "$argument" == *$'\\n'* || "$argument" == *' '* ]]; then
        echo "Invalid IAM member: whitespace" >&2; exit 99
      fi
    done
    ;;
esac
printf '%s\\n' "$*" >> "$GCLOUD_CALLS"
`, { mode: 0o700 });
      const result = spawnSync("bash", ["scripts/firebase/setup-functions-deployment.sh", "--apply"], {
        encoding: "utf8", env: { PATH: `${directory}:/usr/bin:/bin`, GCLOUD_CALLS: calls },
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Google Cloud setup completed");
      const commands = readFileSync(calls, "utf8").trim().split("\n");
      const enableApis = commands.find(command => command.startsWith("services enable "));
      expect(enableApis).toContain("cloudbilling.googleapis.com");
      expect(enableApis).toContain("firebaseextensions.googleapis.com");
      const initialize = commands.findIndex(command => command.startsWith("storage service-agent "));
      const grant = commands.findIndex(command => command.includes("--role=roles/pubsub.publisher"));
      expect(initialize).toBeGreaterThan(-1);
      expect(grant).toBeGreaterThan(initialize);
      expect(commands[grant]).toContain("--member=serviceAccount:service-358734544002@gs-project-accounts.iam.gserviceaccount.com");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("prints the trust plan without executing gcloud by default", () => {
    const result = execFileSync("bash", ["scripts/firebase/setup-functions-deployment.sh"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    expect(result).toContain("Dry-run only");
    expect(result).toContain("assertion.repository_id == '1161047380'");
    expect(result).toContain("refs/heads/main");
  });
  it("rejects unknown options", () => expect(spawnSync("bash", ["scripts/firebase/setup-functions-deployment.sh", "--project=another"], { encoding: "utf8" }).status).toBe(2));
  it("stops before any IAM mutation when the project number differs", () => {
    const directory = mkdtempSync(join(tmpdir(), "hotelsuite-deploy-"));
    try {
      writeFileSync(join(directory, "gcloud"), '#!/bin/bash\nif [[ "$*" == "projects describe hotel-toolkit --format=value(projectNumber)" ]]; then echo 123; else echo "UNEXPECTED MUTATION" >&2; exit 99; fi\n', { mode: 0o700 });
      const result = spawnSync("bash", ["scripts/firebase/setup-functions-deployment.sh", "--apply"], { encoding: "utf8", env: { PATH: `${directory}:/usr/bin:/bin` } });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Project number mismatch");
      expect(result.stderr).not.toContain("UNEXPECTED MUTATION");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
