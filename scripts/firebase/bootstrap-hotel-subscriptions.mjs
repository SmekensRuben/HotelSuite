// Privileged, create-only migration. Dry-run is the default; never imported by CI.
import { readFile } from "node:fs/promises";
import { initializeApp, deleteApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const allowed = ["--project", "--hotel-file", "--operator", "--apply"];
for (let i = 0; i < args.length; i++) {
  if (!allowed.includes(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
  if (args[i] !== "--apply") {
    if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Missing value for ${args[i]}`);
    i++;
  }
}
const projectId = args.includes("--project") ? value("--project") : "";
const hotelFile = args.includes("--hotel-file") ? value("--hotel-file") : "";
const operator = args.includes("--operator") ? value("--operator") : "";
if (!/^[a-z][a-z0-9-]{4,62}$/.test(projectId) || !hotelFile || !operator.trim()) {
  throw new Error("Explicit --project, --hotel-file and --operator are required.");
}
const hotelUids = JSON.parse(await readFile(hotelFile, "utf8"));
if (!Array.isArray(hotelUids) || !hotelUids.length || hotelUids.length > 500
  || hotelUids.some((id) => typeof id !== "string" || !id || id !== id.trim()
    || id.length > 128 || id.includes("/") || [".", ".."].includes(id))
  || new Set(hotelUids).size !== hotelUids.length) {
  throw new Error("Hotel file must contain 1–500 unique, valid hotel document IDs.");
}
const applying = args.includes("--apply");
const app = initializeApp({ projectId, credential: applicationDefault() });
const db = getFirestore(app);
try {
  // Validate the entire reviewed selection before making any change.
  for (const hotelUid of hotelUids) {
    if (!(await db.doc(`hotels/${hotelUid}`).get()).exists) throw new Error(`Hotel not found: ${hotelUid}`);
  }
  console.log(`${applying ? "APPLY" : "DRY RUN"}: project=${projectId}, operator=${operator}, hotels=${hotelUids.length}`);
  for (const hotelUid of hotelUids) {
    const ref = db.doc(`hotelSubscriptions/${hotelUid}`);
    if (!applying) {
      console.log(`${hotelUid}: ${(await ref.get()).exists ? "keep existing subscription" : "would create active/manual/standard, no expiry"}`);
      continue;
    }
    const created = await db.runTransaction(async (transaction) => {
      const [hotel, current] = await Promise.all([
        transaction.get(db.doc(`hotels/${hotelUid}`)), transaction.get(ref),
      ]);
      if (!hotel.exists) throw new Error(`Hotel removed during migration: ${hotelUid}`);
      if (current.exists) return false; // Never reactivate suspended/canceled hotels.
      const timestamp = FieldValue.serverTimestamp();
      transaction.create(ref, { status: "active", planId: "standard", billingMode: "manual",
        validUntil: null, revision: 1, updatedAt: timestamp, updatedBy: `bootstrap:${operator}` });
      transaction.create(db.collection(`hotels/${hotelUid}/subscriptionAudit`).doc(), {
        source: "cloud-shell-bootstrap", operator, previousStatus: null, status: "active",
        planId: "standard", validUntil: null, revision: 1, createdAt: timestamp,
      });
      return true;
    });
    console.log(`${hotelUid}: ${created ? "created" : "kept existing subscription"}`);
  }
} finally {
  await deleteApp(app);
}
