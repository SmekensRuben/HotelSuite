// Synthetic evidence only. None of these records is an import source or outbox.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { STAGING_PROJECT, HOTEL_IDS, MANIFEST_PATH, ownsFixture } from "./staging-data-fixtures.mjs";
import { assertStagingTarget, withStagingDataOperation } from "./staging-data.mjs";

const FIXTURE = "purchasing-monitoring-3b-v1";
const CASES = ["failed", "stalled", "unknown", "paused", "simulated"];
export function parseScenarioArguments(args) {
  const options = { action: args[0], apply: false };
  const seen = new Set();
  for (let index = 1; index < args.length; index++) {
    const key = args[index];
    if (seen.has(key) || !["--project", "--confirm-project", "--apply"].includes(key)) throw new Error("Use unique supported scenario arguments.");
    seen.add(key);
    if (key === "--apply") options.apply = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error("Missing scenario argument value.");
      options[key === "--project" ? "projectId" : "confirmProject"] = value;
    }
  }
  if (!["seed", "recover", "cleanup"].includes(options.action) || options.projectId !== STAGING_PROJECT
    || options.apply && options.confirmProject !== STAGING_PROJECT) {
    throw new Error("Use seed|recover|cleanup --project hotel-toolkit-staging [--apply --confirm-project hotel-toolkit-staging]. Production is forbidden.");
  }
  return options;
}

export function scenarioRecords(now = Date.now()) {
  return CASES.map((name) => ({ id: `monitoring-3b-${name}`, data: { monitoringFixture: FIXTURE,
    environment: "staging", state: name === "stalled" ? "processing" : name === "unknown" ? "legacy" : name,
    createdAt: now - 2 * 86400000, updatedAt: now - 2 * 86400000,
    ...(name === "stalled" ? { leaseUntil: now - 60000 } : {}),
    ...(name === "paused" ? { paused: true } : {}),
    ...(name === "simulated" ? { simulated: true } : {}),
    descriptor: { hotelUid: HOTEL_IDS[0], fileType: "monitoringFixture",
      name: `imports/${HOTEL_IDS[0]}/monitoring-fixture/${name}.synthetic` } } }));
}

export async function applyScenarios(db, options, { now = Date.now(), apply = options.apply } = {}) {
  // Runtime routing, provenance and the existing staging release/data lock all
  // remain mandatory; a similarly named production hotel is never accepted.
  if (db.projectId !== STAGING_PROJECT) throw new Error("Synthetic monitoring scenarios require the real staging project.");
  assertStagingTarget(db);
  const hotelUid = HOTEL_IDS[0], records = scenarioRecords(now);
  return db.runTransaction(async (tx) => {
    const [manifest, hotel, release, marker, ...existing] = await Promise.all([
      tx.get(db.doc(MANIFEST_PATH)), tx.get(db.doc(`hotels/${hotelUid}`)), tx.get(db.doc("_staging/release")),
      tx.get(db.doc("platformConfiguration/purchasingMonitoring")),
      ...records.map(({ id }) => tx.get(db.doc(`hotels/${hotelUid}/importRuns/${id}`))),
    ]);
    if (manifest.data()?.status !== "complete" || !ownsFixture(manifest.data()) || !ownsFixture(hotel.data())
      || release.data()?.state !== "ready") throw new Error("Require the owned fictional hotel and a completed protected staging release first.");
    const require = createRequire(import.meta.url);
    const { validatePurchasingMonitoringConfiguration } = require("../../functions/src/purchasingMonitoringConfig");
    const configuration = validatePurchasingMonitoringConfiguration(marker.data(), { projectId: STAGING_PROJECT, requireEnabled: options.action !== "cleanup" });
    if (options.action !== "cleanup" && (!/^[a-f0-9]{40}$/.test(release.data()?.sha || "") || configuration.releaseSha !== release.data().sha)) {
      throw new Error("The protected staging release and monitoring activation must identify the same reviewed SHA.");
    }
    for (const row of existing) if (row.exists && row.data().monitoringFixture !== FIXTURE) throw new Error("A scenario ID is occupied by unowned evidence.");
    if (options.action === "seed" && existing.some((row) => row.exists)) throw new Error("Scenarios are create-only; recover and clean up the owned evidence before seeding again.");
    if (options.action === "recover" && existing.some((row) => !row.exists)) throw new Error("Seed every owned scenario before demonstrating recovery.");
    if (apply) for (const [index, { id, data }] of records.entries()) {
      const ref = db.doc(`hotels/${hotelUid}/importRuns/${id}`);
      if (options.action === "seed") tx.create(ref, data);
      else if (options.action === "recover") tx.set(ref, { monitoringFixture: FIXTURE, environment: "staging",
        state: "complete", createdAt: data.createdAt, updatedAt: now, completedAt: now,
        result: { writtenCount: 0 }, descriptor: data.descriptor });
      else if (existing[index].exists) tx.delete(ref);
    }
    return { projectId: STAGING_PROJECT, hotelUid, fixture: FIXTURE, action: options.action,
      mode: apply ? "APPLIED SYNTHETIC EVIDENCE" : "READ-ONLY PREFLIGHT / DRY RUN", records: records.map(({ id }) => id),
      warning: "Fictional staging evidence only. No import file, business action, provider request or delivery is executed. Retained incidents are preserved." };
  });
}

export async function main(args = process.argv.slice(2)) {
  const options = parseScenarioArguments(args);
  const require = createRequire(new URL("../../functions/package.json", import.meta.url));
  const { initializeApp, applicationDefault, deleteApp } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  const app = initializeApp({ projectId: STAGING_PROJECT, credential: applicationDefault() });
  try {
    const db = getFirestore(app);
    const result = options.apply ? await withStagingDataOperation(db, `monitoring-${options.action}`, () => applyScenarios(db, options))
      : await applyScenarios(db, options);
    console.log(JSON.stringify(result, null, 2));
  } finally { await deleteApp(app); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error("Synthetic monitoring scenario preflight or operation failed. Check staging identity, owned fixture, protected release and monitoring configuration."); process.exitCode = 1; });
}
