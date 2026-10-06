import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { mkdir, writeFile } from "node:fs/promises";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("This script may only run against FIRESTORE_EMULATOR_HOST.");
}

const app = initializeApp({
  projectId: process.env.GCLOUD_PROJECT || "demo-hotel-suite-a00",
});
const database = getFirestore(app);
const reference = database.doc("a00RestoreChecks/initial-backup");

if (process.argv[2] === "seed-and-export") {
  const exportDirectory = process.argv[3];
  if (!exportDirectory?.startsWith("/")) throw new Error("An absolute export directory is required.");
  await reference.set({ marker: "fictional-data-only", hotelUids: ["hotel-a", "hotel-b"] });
  console.log("Seeded fictional restore marker.");
  await mkdir(exportDirectory, { recursive: true });
  const response = await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${app.options.projectId}:export`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        database: `projects/${app.options.projectId}/databases/(default)`,
        export_directory: exportDirectory,
        export_name: "firestore_export",
      }),
    },
  );
  if (!response.ok) throw new Error(`Emulator export failed: ${response.status} ${await response.text()}`);
  await writeFile(`${exportDirectory}/firebase-export-metadata.json`, JSON.stringify({
    version: "15.32.1",
    firestore: {
      version: "1.22.0",
      path: "firestore_export",
      metadata_file: "firestore_export/firestore_export.overall_export_metadata",
    },
  }, null, 2));
  console.log(`Exported fictional marker to ${exportDirectory}.`);
} else if (process.argv[2] === "verify") {
  const snapshot = await reference.get();
  if (!snapshot.exists || snapshot.data()?.marker !== "fictional-data-only") {
    throw new Error("Restored marker does not match the exported fixture.");
  }
  console.log("Verified restored fictional marker.");
} else {
  throw new Error("Expected seed-and-export or verify mode.");
}

await deleteApp(app);
