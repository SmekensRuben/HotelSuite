import { readFile } from "node:fs/promises";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, setDoc, deleteDoc } from "firebase/firestore";
import { getBytes, ref, uploadString, uploadBytes } from "firebase/storage";

let testEnvironment;
const projectId = "demo-hotel-suite-a00";

before(async () => {
  const [firestoreRules, storageRules] = await Promise.all([
    readFile("firebase/firestore.rules", "utf8"),
    readFile("firebase/storage.rules", "utf8"),
  ]);
  testEnvironment = await initializeTestEnvironment({
    projectId,
    firestore: { host: "127.0.0.1", port: 8080, rules: firestoreRules },
    storage: {
      host: "127.0.0.1",
      port: 9199,
      rules: storageRules,
    },
  });
});

beforeEach(async () => {
  await testEnvironment.clearFirestore();
  await testEnvironment.clearStorage();
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    await Promise.all([
      ...["hotel-a", "hotel-b"].map((hotelUid) => setDoc(doc(context.firestore(), "hotelSubscriptions", hotelUid), { status: "active", validUntil: null })),
      setDoc(doc(context.firestore(), "hotels/hotel-a/members", "admin-a"), { permissions: ["contracts.*", "imports.*"] }),
      setDoc(doc(context.firestore(), "hotels/hotel-a/members", "employee-a"), { permissions: ["contracts.read"] }),
      setDoc(doc(context.firestore(), "hotels/hotel-a/members", "catalog-a"), { permissions: ["catalogproducts.read", "catalogproducts.update"] }),
      setDoc(doc(context.firestore(), "users", "admin-a"), {
        hotelUid: ["hotel-a"],
        permissions: ["contracts.*", "settings.*"],
      }),
      setDoc(doc(context.firestore(), "users", "employee-a"), {
        hotelUid: ["hotel-a"],
        permissions: ["contracts.read"],
      }),
    ]);
  });
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    await uploadString(ref(context.storage(), "hotels/hotel-a/contracts/contract-a/file.pdf"), "fixture");
    await uploadString(ref(context.storage(), "hotels/hotel-b/contracts/contract-b/file.pdf"), "fixture");
    await uploadString(ref(context.storage(), "hotels/hotel-a/catalogproducts/product-a/images/file.jpg"), "fixture");
  });
});

after(async () => testEnvironment.cleanup());

describe("Storage tenant and action boundaries", () => {
  it("rejects unverified identities and empty or oversized uploads, including platform administrators", async () => {
    const unverified = testEnvironment.authenticatedContext("admin-a", { email_verified: false }).storage();
    await assertFails(getBytes(ref(unverified, "hotels/hotel-a/contracts/contract-a/file.pdf")));
    const storage = testEnvironment.authenticatedContext("platform", { email_verified: true, platformAdmin: true }).storage();
    await assertFails(uploadString(ref(storage, "hotels/hotel-a/contracts/empty.pdf"), ""));
    await assertFails(uploadBytes(ref(storage, "hotels/hotel-a/contracts/oversized.pdf"), new Uint8Array(20 * 1024 * 1024 + 1)));
  });
  it("revokes file access immediately even when an old ID token has hotel permissions", async () => {
    const storage = testEnvironment.authenticatedContext("employee-a", { email_verified: true, hotelPermissions: { "hotel-a": ["contracts.*"] } }).storage();
    const file = ref(storage, "hotels/hotel-a/contracts/contract-a/file.pdf");
    await assertFails(getBytes(file));
    await testEnvironment.withSecurityRulesDisabled((context) => deleteDoc(doc(context.firestore(), "hotels/hotel-a/members", "employee-a")));
    await assertFails(getBytes(file));
  });

  it("blocks Storage access for suspended subscriptions", async () => {
    const storage = testEnvironment.authenticatedContext("employee-a", { email_verified: true }).storage();
    await testEnvironment.withSecurityRulesDisabled((context) => setDoc(doc(context.firestore(), "hotelSubscriptions", "hotel-a"), { status: "suspended", validUntil: null }));
    await assertFails(getBytes(ref(storage, "hotels/hotel-a/contracts/contract-a/file.pdf")));
  });
  it("requires the backend even for a contract reader's own hotel file", async () => {
    const storage = testEnvironment.authenticatedContext("employee-a", { email_verified: true,
      hotelPermissions: { "hotel-a": ["contracts.read"] },
    }).storage();
    await assertFails(getBytes(ref(storage, "hotels/hotel-a/contracts/contract-a/file.pdf")));
    await assertFails(getBytes(ref(storage, "hotels/hotel-b/contracts/contract-b/file.pdf")));
  });

  it("denies browser contract uploads even with all contract permissions", async () => {
    const employeeStorage = testEnvironment.authenticatedContext("employee-a", { email_verified: true,
      hotelPermissions: { "hotel-a": ["contracts.read"] },
    }).storage();
    await assertFails(uploadString(ref(employeeStorage, "hotels/hotel-a/contracts/new/file.pdf"), "denied"));

    const adminStorage = testEnvironment.authenticatedContext("admin-a", { email_verified: true,
      hotelPermissions: { "hotel-a": ["contracts.*", "imports.*"] },
    }).storage();
    await assertFails(uploadString(ref(adminStorage, "hotels/hotel-a/contracts/new/file.pdf"), "allowed"));
  });

  it("denies anonymous storage access", async () => {
    const storage = testEnvironment.unauthenticatedContext().storage();
    await assertFails(getBytes(ref(storage, "hotels/hotel-a/contracts/contract-a/file.pdf")));
  });

  it("uses product permissions and preserves hotel boundaries for product images", async () => {
    const storage = testEnvironment.authenticatedContext("catalog-a", { email_verified: true,
      hotelPermissions: { "hotel-a": ["catalogproducts.read", "catalogproducts.update"], "hotel-b": ["catalogproducts.read"] },
    }).storage();
    await assertSucceeds(getBytes(ref(storage, "hotels/hotel-a/catalogproducts/product-a/images/file.jpg")));
    await assertSucceeds(uploadString(ref(storage, "hotels/hotel-a/catalogproducts/product-a/images/new.jpg"), "allowed", "raw", { contentType: "image/jpeg" }));
    await assertFails(uploadString(ref(storage, "hotels/hotel-b/catalogproducts/product-b/images/new.jpg"), "denied", "raw", { contentType: "image/jpeg" }));
  });
  it("revokes an allowed image path after membership removal despite retained token claims", async () => {
    const storage = testEnvironment.authenticatedContext("catalog-a", { email_verified: true, hotelPermissions: { "hotel-a": ["catalogproducts.*"] } }).storage();
    const file = ref(storage, "hotels/hotel-a/catalogproducts/product-a/images/file.jpg");
    await assertSucceeds(getBytes(file));
    await testEnvironment.withSecurityRulesDisabled((context) => deleteDoc(doc(context.firestore(), "hotels/hotel-a/members", "catalog-a")));
    await assertFails(getBytes(file));
    await assertFails(uploadBytes(ref(storage, "hotels/hotel-a/catalogproducts/new.jpg"), new Uint8Array([1]), { contentType: "image/jpeg" }));
  });
  it("blocks allowed image reads and uploads after suspension or expiry", async () => {
    const storage = testEnvironment.authenticatedContext("catalog-a", { email_verified: true }).storage();
    const file = ref(storage, "hotels/hotel-a/catalogproducts/product-a/images/file.jpg");
    await assertSucceeds(getBytes(file));
    for (const subscription of [{ status: "suspended", validUntil: null }, { status: "active", validUntil: new Date(0) }]) {
      await testEnvironment.withSecurityRulesDisabled((context) => setDoc(doc(context.firestore(), "hotelSubscriptions", "hotel-a"), subscription));
      await assertFails(getBytes(file));
      await assertFails(uploadBytes(ref(storage, "hotels/hotel-a/catalogproducts/new.jpg"), new Uint8Array([1]), { contentType: "image/jpeg" }));
    }
  });
  it("enforces verified identity, positive size, maximum size and safe image MIME on an operational path", async () => {
    const storage = testEnvironment.authenticatedContext("catalog-a", { email_verified: true }).storage();
    const target = ref(storage, "hotels/hotel-a/catalogproducts/new.jpg");
    await assertSucceeds(uploadBytes(target, new Uint8Array([1]), { contentType: "image/jpeg" }));
    await assertFails(uploadBytes(target, new Uint8Array(), { contentType: "image/jpeg" }));
    await assertFails(uploadBytes(target, new Uint8Array(20 * 1024 * 1024 + 1), { contentType: "image/jpeg" }));
    await assertFails(uploadBytes(target, new Uint8Array([1]), { contentType: "text/html" }));
    const unverified = testEnvironment.authenticatedContext("catalog-a", { email_verified: false }).storage();
    await assertFails(getBytes(ref(unverified, target.fullPath)));
    const platform = testEnvironment.authenticatedContext("platform", { email_verified: true, platformAdmin: true }).storage();
    await assertFails(uploadBytes(ref(platform, target.fullPath), new Uint8Array([1]), { contentType: "text/html" }));
  });
  it("permits bounded declared import formats and rejects active content", async () => {
    const storage = testEnvironment.authenticatedContext("admin-a", { email_verified: true }).storage();
    await assertSucceeds(uploadString(ref(storage, "imports/hotel-a/fixture.csv"), "id,value\n1,fixture", "raw", { contentType: "text/csv" }));
    await assertFails(uploadString(ref(storage, "imports/hotel-a/fixture.html"), "fixture", "raw", { contentType: "text/html" }));
  });
});
