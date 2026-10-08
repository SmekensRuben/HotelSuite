import { readFile } from "node:fs/promises";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, setDoc } from "firebase/firestore";
import { getBytes, ref, uploadString } from "firebase/storage";

let testEnvironment;
const projectId = "hotel-suite-a00";

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
  it("allows contract readers to download only their hotel's file", async () => {
    const storage = testEnvironment.authenticatedContext("employee-a", {
      hotelPermissions: { "hotel-a": ["contracts.read"] },
    }).storage();
    await assertSucceeds(getBytes(ref(storage, "hotels/hotel-a/contracts/contract-a/file.pdf")));
    await assertFails(getBytes(ref(storage, "hotels/hotel-b/contracts/contract-b/file.pdf")));
  });

  it("requires a write permission for contract uploads", async () => {
    const employeeStorage = testEnvironment.authenticatedContext("employee-a", {
      hotelPermissions: { "hotel-a": ["contracts.read"] },
    }).storage();
    await assertFails(uploadString(ref(employeeStorage, "hotels/hotel-a/contracts/new/file.pdf"), "denied"));

    const adminStorage = testEnvironment.authenticatedContext("admin-a", {
      hotelPermissions: { "hotel-a": ["contracts.*", "imports.*"] },
    }).storage();
    await assertSucceeds(uploadString(ref(adminStorage, "hotels/hotel-a/contracts/new/file.pdf"), "allowed"));
  });

  it("denies anonymous storage access", async () => {
    const storage = testEnvironment.unauthenticatedContext().storage();
    await assertFails(getBytes(ref(storage, "hotels/hotel-a/contracts/contract-a/file.pdf")));
  });

  it("uses product permissions and preserves hotel boundaries for product images", async () => {
    const storage = testEnvironment.authenticatedContext("catalog-a", {
      hotelPermissions: { "hotel-a": ["catalogproducts.read", "catalogproducts.update"], "hotel-b": ["catalogproducts.read"] },
    }).storage();
    await assertSucceeds(getBytes(ref(storage, "hotels/hotel-a/catalogproducts/product-a/images/file.jpg")));
    await assertSucceeds(uploadString(ref(storage, "hotels/hotel-a/catalogproducts/product-a/images/new.jpg"), "allowed"));
    await assertFails(uploadString(ref(storage, "hotels/hotel-b/catalogproducts/product-b/images/new.jpg"), "denied"));
  });
});
