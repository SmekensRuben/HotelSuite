import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { FUNCTIONS_PROJECT, requireFunctionsConfiguration } from "./functions-release-policy.mjs";
import { requireRetryInventory, planReviewedRetryActivation } from "./functions-retry-policy.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const firebaseCli = fileURLToPath(new URL("../../node_modules/firebase-tools/lib/bin/firebase.js", import.meta.url));
const require = createRequire(import.meta.url);

function runFirebase(args, { capture = false } = {}) {
  if (capture) return execFileSync(process.execPath, [firebaseCli, ...args], { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  const result = spawnSync(process.execPath, [firebaseCli, ...args], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Firebase deployment failed (${result.signal || result.status}).`);
}

export function deployReviewedFunctions({ env = process.env, run = runFirebase,
  loadFunctions = config => {
    process.env.FIREBASE_CONFIG = JSON.stringify(config);
    return require("../../functions/index.js");
  } } = {}) {
  if (env.GITHUB_ACTIONS !== "true" || env.FIREBASE_FUNCTIONS_DEPLOY_ENABLED !== "true") {
    throw new Error("Reviewed Functions deployment requires the enabled GitHub release workflow.");
  }
  requireFunctionsConfiguration(env);
  const inventory = JSON.parse(run(["functions:list", "--project", FUNCTIONS_PROJECT, "--non-interactive", "--json"], { capture: true }));
  const deployed = requireRetryInventory(inventory);
  const functionExports = loadFunctions({ projectId: FUNCTIONS_PROJECT, storageBucket: deployed.eventTrigger.eventFilters.bucket });
  const retryArgs = planReviewedRetryActivation(functionExports, inventory);
  if (retryArgs.length) {
    console.log("Enabling reviewed retries for processImportedFileToFirestore(us-west1) only.");
    run(retryArgs);
  }
  // Keep the full deployment unforced: removals and further retry changes stop CI.
  run(["deploy", "--only", "functions", "--project", FUNCTIONS_PROJECT, "--non-interactive"]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) deployReviewedFunctions();
