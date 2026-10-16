import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, setDoc } from "firebase/firestore";

test("public release metadata is read-only and does not expose other staging control documents", async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Only the local Firestore emulator is allowed.");
  const environment = await initializeTestEnvironment({ projectId: "demo-hotel-suite-a00", firestore: {
    host: "127.0.0.1", port: 8080, rules: await readFile("firebase/firestore.rules", "utf8"),
  } });
  try {
    await environment.clearFirestore();
    const release = { state: "ready", sha: "a".repeat(40), backendSha: "a".repeat(40), frontendSha: "a".repeat(40) };
    await environment.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), "_staging/release"), release);
      await setDoc(doc(context.firestore(), "_staging/dataOperation"), { status: "running" });
    });
    for (const context of [environment.unauthenticatedContext(), environment.authenticatedContext("operator", { platformAdmin: true, email_verified: true })]) {
      const db = context.firestore();
      await assertSucceeds(getDoc(doc(db, "_staging/release")));
      await assertFails(getDocs(collection(db, "_staging")));
      await assertFails(getDoc(doc(db, "_staging/dataOperation")));
      await assertFails(setDoc(doc(db, "_staging/release"), { ...release, state: "ready" }));
    }
  } finally { await environment.cleanup(); }
});
