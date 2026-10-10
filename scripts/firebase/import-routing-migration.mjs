import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import identity from "../../functions/src/importIdentity.js";
const { stableId, normalizeReceiver, receiverId, requireSegment, importProjectionId, syncImportProjection } = identity;
const collections = [["fileImportSettings", "fileImportSettingsIndex"], ["fileImportTypes", "fileImportTypesIndex"]];
function sourceIdentity(path) {
  const match = String(path).match(/^hotels\/([^/]+)\/fileImportSettings\/([^/]+)$/);
  if (!match) throw new Error("A setting move needs an exact canonical source path");
  requireSegment(match[1], "move hotel"); requireSegment(match[2], "move setting"); return match;
}
export function validateImportManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.projectId !== "string" || !manifest.projectId
    || !Array.isArray(manifest.bindings) || !manifest.bindings.length) throw new Error("Explicit project and receiving identity bindings are required");
  const receivers = new Set();
  const bindings = manifest.bindings.map((binding) => {
    const receiver = normalizeReceiver(binding.receiver), hotelUid = requireSegment(binding.hotelUid, "binding hotel");
    if (receivers.has(receiver)) throw new Error("A receiving identity must have exactly one manifest binding");
    if (typeof binding.enabled !== "boolean" || typeof binding.ownershipEvidence !== "string" || !binding.ownershipEvidence.trim()
      || binding.ownershipEvidence.length > 1000) throw new Error("Every binding needs explicit enablement and reviewed ownership evidence");
    receivers.add(receiver);
    return { schemaVersion: 1, provider: "resend", receiver, hotelUid, enabled: binding.enabled,
      ownershipEvidence: binding.ownershipEvidence.trim() };
  });
  const moved = new Set();
  const settingMoves = (manifest.settingMoves || []).map((move) => {
    const match = sourceIdentity(move.sourcePath), fromReceiver = normalizeReceiver(move.fromReceiver), toReceiver = normalizeReceiver(move.toReceiver);
    if (moved.has(move.sourcePath) || fromReceiver === toReceiver) throw new Error("Setting moves must be unique and change the receiver");
    if (!bindings.some((binding) => binding.hotelUid === match[1] && binding.receiver === toReceiver && binding.enabled)) {
      throw new Error("Setting move destination must be an enabled receiving identity of its own hotel");
    }
    moved.add(move.sourcePath);
    return { sourcePath: move.sourcePath, fromReceiver, toReceiver };
  });
  return { projectId: manifest.projectId, bindings, settingMoves };
}
export async function inspectImportMigration(db, manifest) {
  const validated = validateImportManifest(manifest), issues = [], sources = [], moves = [], legacy = [], orphans = [], receivingSnapshots = [], projections = [];
  const hotels = await db.collection("hotels").limit(501).get();
  if (hotels.size > 500) throw new Error("More than 500 hotels require a staged import migration");
  const hotelIds = new Set(hotels.docs.map((snapshot) => snapshot.id));
  const bound = new Map(validated.bindings.map((binding) => [binding.receiver, binding]));
  for (const binding of validated.bindings) {
    if (!hotelIds.has(binding.hotelUid)) issues.push({ receiver: binding.receiver, issue: "Manifest receiving hotel does not exist" });
    const current = await db.doc(`importReceivingIdentities/${receiverId(binding.receiver)}`).get();
    receivingSnapshots.push({ path: current.ref.path, data: current.exists ? current.data() : null });
    if (current.exists && (current.data().hotelUid !== binding.hotelUid || current.data().receiver !== binding.receiver || current.data().provider !== "resend")) {
      issues.push({ receiver: binding.receiver, issue: "Existing receiving identity has another owner; automatic transfer is prohibited" });
    }
  }
  for (const hotel of hotels.docs) {
    requireSegment(hotel.id, "hotel ID");
    const routeKeys = new Set(), typeKeys = new Set();
    for (const [sourceCollection, indexCollection] of collections) {
      const page = await db.collection(`hotels/${hotel.id}/${sourceCollection}`).limit(2001).get();
      if (page.size > 2000) throw new Error("More than 2000 import sources in a hotel require a staged migration");
      for (const snapshot of page.docs) {
        const sourcePath = snapshot.ref.path, data = snapshot.data();
        const source = { hotelUid: hotel.id, localId: snapshot.id, sourceCollection, indexCollection, sourcePath, data };
        sources.push(source);
        if (sourceCollection === "fileImportTypes") {
          if (data.enabled !== false) {
            const key = String(data.fileType || "");
            if (!/^[a-z0-9_-]+$/.test(key) || typeKeys.has(key)) issues.push({ sourcePath, issue: "File type is not unique and normalized among enabled canonical types" });
            typeKeys.add(key);
          }
          continue;
        }
        let receiver;
        try { receiver = normalizeReceiver(data.toEmail); }
        catch { issues.push({ sourcePath, issue: "Legacy receiving address needs explicit correction" }); continue; }
        const move = validated.settingMoves.find((entry) => entry.sourcePath === sourcePath);
        if (move) {
          if (receiver !== move.fromReceiver && receiver !== move.toReceiver) {
            issues.push({ sourcePath, issue: "Move source address changed; review manifest again" }); continue;
          }
          if (receiver === move.fromReceiver) moves.push({ ...move, source });
          receiver = move.toReceiver;
        }
        if (data.enabled === false) continue;
        const binding = bound.get(receiver);
        if (!binding || binding.hotelUid !== hotel.id || !binding.enabled) {
          issues.push({ sourcePath, receiver, issue: "Enabled legacy setting has no explicit enabled receiving identity owned by this hotel" }); continue;
        }
        if (data.receiverId && data.receiverId !== receiverId(receiver) && !move) issues.push({ sourcePath, issue: "Existing receiverId differs from the reviewed receiving identity" });
        const pattern = String(data.subjectContains || data.subject || "").trim().toLowerCase();
        const from = String(data.fromEmail || "").trim().toLowerCase();
        const routeKey = JSON.stringify([receiver, from, pattern]);
        if (!from || !pattern || routeKeys.has(routeKey)) issues.push({ sourcePath, issue: "Missing or exactly duplicated enabled sender/subject route" });
        routeKeys.add(routeKey);
      }
    }
  }
  for (const move of validated.settingMoves) if (!sources.some((source) => source.sourcePath === move.sourcePath)) issues.push({ sourcePath: move.sourcePath, issue: "Setting move source does not exist" });
  for (const [, indexCollection] of collections) {
    const page = await db.collection(indexCollection).limit(10001).get();
    if (page.size > 10000) throw new Error("More than 10000 import projections require a staged migration");
    for (const snapshot of page.docs) {
      projections.push({ path: snapshot.ref.path, data: snapshot.data() });
      if (snapshot.data().projectionVersion !== 2) legacy.push({ path: snapshot.ref.path, data: snapshot.data() });
      else {
        const data = snapshot.data(), collection = collections.find(([, index]) => index === indexCollection)[0];
        if (!data.hotelUid || !data.id || data.sourcePath !== `hotels/${data.hotelUid}/${collection}/${data.id}`
          || snapshot.id !== importProjectionId(data.hotelUid, data.id)) issues.push({ path: snapshot.ref.path, issue: "Qualified projection ownership needs operator review" });
        else if (!sources.some((source) => source.sourcePath === data.sourcePath)) orphans.push({ hotelUid: data.hotelUid, localId: data.id, sourceCollection: collection, indexCollection });
      }
    }
  }
  return { ...validated, sources, moves, legacy, orphans, receivingSnapshots, projections, summary: { hotels: hotels.size, canonicalSources: sources.length,
    receivingBindings: validated.bindings.length, explicitSettingMoves: moves.length, legacyProjections: legacy.length, orphanQualifiedProjections: orphans.length, issues } };
}
export async function applyImportMigration(db, inspection, { pruneLegacy = false } = {}) {
  if (inspection.summary.issues.length) throw new Error("Resolve every preflight issue before applying import migration");
  for (const binding of inspection.bindings) await db.runTransaction(async (tx) => {
    const ref = db.doc(`importReceivingIdentities/${receiverId(binding.receiver)}`), current = await tx.get(ref);
    const hotel = await tx.get(db.doc(`hotels/${binding.hotelUid}`));
    if (!hotel.exists) throw new Error("Receiving hotel disappeared during migration");
    if (current.exists && (current.data().hotelUid !== binding.hotelUid || current.data().receiver !== binding.receiver || current.data().provider !== "resend")) throw new Error("Receiving identity ownership changed during migration");
    tx.set(ref, { ...binding, provisionedAt: current.data()?.provisionedAt || Date.now(), reviewedAt: Date.now() });
  });
  for (const move of inspection.moves) await db.runTransaction(async (tx) => {
    const ref = db.doc(move.sourcePath), current = await tx.get(ref);
    if (!current.exists || stableId(current.data()) !== stableId(move.source.data)) throw new Error("Canonical setting changed during migration; rerun preflight");
    tx.update(ref, { toEmail: move.toReceiver, receiverId: receiverId(move.toReceiver), receiverMigratedAt: Date.now() });
  });
  for (const source of [...inspection.sources, ...inspection.orphans]) await syncImportProjection(db, source);
  // Pruning is explicit and only removes the exact backed-up legacy snapshot.
  // Newly qualified documents and concurrently changed records are never deleted.
  if (pruneLegacy) for (const entry of inspection.legacy) await db.runTransaction(async (tx) => {
    const ref = db.doc(entry.path), current = await tx.get(ref);
    if (!current.exists) return;
    if (current.data().projectionVersion === 2 || stableId(current.data()) !== stableId(entry.data)) throw new Error("Legacy projection changed during migration; rerun preflight");
    tx.delete(ref);
  });
}
async function main() {
  const [mode, manifestPath, ...args] = process.argv.slice(2);
  const option = (name) => args[args.indexOf(name) + 1];
  for (let index = 0; index < args.length; index += 1) {
    if (["--emulator", "--prune-legacy"].includes(args[index])) continue;
    if (!["--project", "--backup", "--confirm-project"].includes(args[index]) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("Unsupported or missing operator argument");
    index += 1;
  }
  const projectId = args.includes("--project") ? option("--project") : "";
  const emulator = args.includes("--emulator"), pruneLegacy = args.includes("--prune-legacy");
  if (!["preflight", "apply"].includes(mode) || !manifestPath || !projectId) throw new Error("Use preflight|apply manifest.json --project PROJECT [--emulator] [--prune-legacy] [--backup FILE --confirm-project PROJECT]");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.projectId !== projectId) throw new Error("Manifest and explicit project disagree");
  if (emulator && (!projectId.startsWith("demo-") || !/^(localhost|127\.0\.0\.1):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || ""))) throw new Error("Emulator mode requires a demo project and local Firestore emulator");
  if (!emulator && process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Remove emulator configuration for an operator run");
  if (mode === "apply" && (!args.includes("--backup") || option("--confirm-project") !== projectId)) throw new Error("Apply requires an unused backup filename and exact --confirm-project");
  const require = createRequire(new URL("../../functions/package.json", import.meta.url));
  const { initializeApp, deleteApp } = require("firebase-admin/app"), { getFirestore } = require("firebase-admin/firestore");
  const app = initializeApp({ projectId }), db = getFirestore(app);
  try {
    const inspection = await inspectImportMigration(db, manifest);
    console.log(JSON.stringify({ projectId, mode, ...inspection.summary }, null, 2));
    if (mode === "apply") {
      await writeFile(option("--backup"), JSON.stringify({ projectId, manifest, sources: inspection.sources, receivingSnapshots: inspection.receivingSnapshots, projections: inspection.projections }, null, 2), { flag: "wx", mode: 0o600 });
      await applyImportMigration(db, inspection, { pruneLegacy });
      const after = await inspectImportMigration(db, manifest);
      console.log(JSON.stringify({ projectId, mode: "verification", ...after.summary }, null, 2));
      if (after.summary.issues.length || (pruneLegacy && after.summary.legacyProjections) || after.summary.orphanQualifiedProjections) throw new Error("Migration verification needs operator review; keep inbound delivery paused");
    }
  } finally { await db.terminate(); await deleteApp(app); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
