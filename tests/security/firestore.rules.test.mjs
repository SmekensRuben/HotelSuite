import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  setDoc,
  Timestamp,
  updateDoc,
} from "firebase/firestore";

const projectId = "demo-hotel-suite-a00";
let testEnvironment;

const profiles = {
  platformAdmin: {
    uid: "platform-admin",
    claims: { platformAdmin: true },
    profile: { hotelUid: ["hotel-a", "hotel-b"], permissions: [] },
  },
  hotelAdminA: {
    uid: "hotel-admin-a",
    claims: {},
    profile: {
      hotelUid: ["hotel-a"],
      permissions: ["catalogproducts.*", "groups.*", "settings.*", "users.read", "users.update"],
    },
  },
  employeeA: {
    uid: "employee-a",
    claims: {},
    profile: { hotelUid: ["hotel-a"], permissions: ["catalogproducts.read"] },
  },
  employeeB: {
    uid: "employee-b",
    claims: {},
    profile: { hotelUid: ["hotel-b"], permissions: ["catalogproducts.read"] },
  },
  multiHotelUser: {
    uid: "multi-hotel-user",
    claims: {},
    profile: { hotelUid: ["hotel-a", "hotel-b"], permissions: [] },
  },
  specialistA: {
    uid: "specialist-a",
    claims: {},
    profile: { hotelUid: ["hotel-a"], permissions: [] },
  },
  noPermissionsA: {
    uid: "no-permissions-a",
    claims: {},
    profile: { hotelUid: ["hotel-a"], permissions: [] },
  },
};

const databaseFor = (actor) =>
  testEnvironment.authenticatedContext(actor.uid, { email_verified: true, ...actor.claims }).firestore();

async function seedIsolatedHotels() {
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    const database = context.firestore();
    await Promise.all([
      ...["hotel-a", "hotel-b"].map((hotelUid) => setDoc(doc(database, "hotelSubscriptions", hotelUid), { status: "active", validUntil: null })),
      ...Object.values(profiles).map((actor) =>
        setDoc(doc(database, "users", actor.uid), actor.profile),
      ),
      setDoc(doc(database, "hotels/hotel-a/members", profiles.hotelAdminA.uid), {
        permissions: profiles.hotelAdminA.profile.permissions,
      }),
      setDoc(doc(database, "hotels/hotel-a/members", profiles.employeeA.uid), {
        permissions: profiles.employeeA.profile.permissions,
      }),
      setDoc(doc(database, "hotels/hotel-b/members", profiles.employeeB.uid), {
        permissions: profiles.employeeB.profile.permissions,
      }),
      setDoc(doc(database, "hotels/hotel-a/members", profiles.multiHotelUser.uid), {
        permissions: ["catalogproducts.read"],
      }),
      setDoc(doc(database, "hotels/hotel-b/members", profiles.multiHotelUser.uid), {
        permissions: ["catalogproducts.create"],
      }),
      setDoc(doc(database, "hotels/hotel-a/members", profiles.specialistA.uid), {
        permissions: [
          "reservations.read", "demandcalendar.*", "orders.read", "orders.approve",
          "contracts.read", "contracts.notify", "roominglists.read", "roominglists.approve",
        ],
      }),
      setDoc(doc(database, "hotels/hotel-a/members", profiles.noPermissionsA.uid), {
        permissions: [],
      }),
      setDoc(doc(database, "hotels", "hotel-a"), { hotelName: "Fictional Hotel A" }),
      setDoc(doc(database, "hotels", "hotel-b"), { hotelName: "Fictional Hotel B" }),
      setDoc(doc(database, "hotels/hotel-a/catalogproducts", "product-a"), { name: "A coffee" }),
      setDoc(doc(database, "hotels/hotel-b/catalogproducts", "product-b"), { name: "B coffee" }),
      setDoc(doc(database, "hotels/hotel-a/reports/arrivalsdetailed/2026-10-05", "arrival-a"), { guest: "Fixture" }),
      setDoc(doc(database, "hotels/hotel-a/orders", "order-a"), { status: "Created", dispatchStatus: "" }),
      setDoc(doc(database, "roomingListLinks", "public-token-a"), {
        hotelUid: "hotel-a",
        groupName: "Fictional conference",
        publicAccessEnabled: true,
        publicAccessExpiresAt: Timestamp.fromMillis(Date.now() + 60_000),
      }),
      setDoc(doc(database, "roomingListLinks/public-token-a/versions", "1"), {
        status: "Official",
      }),
    ]);
  });
}

before(async () => {
  testEnvironment = await initializeTestEnvironment({
    projectId,
    firestore: {
      host: "127.0.0.1",
      port: 8080,
      rules: await readFile("firebase/firestore.rules", "utf8"),
    },
  });
});


beforeEach(async () => {
  await testEnvironment.clearFirestore();
  await seedIsolatedHotels();
});

after(async () => {
  await testEnvironment.cleanup();
});

describe("module and special-action boundaries", () => {
  it("blocks module access when a subscription is suspended, expired or missing", async () => {
    const database = databaseFor(profiles.employeeA);
    const product = doc(database, "hotels/hotel-a/catalogproducts", "product-a");
    for (const subscription of [{ status: "suspended", validUntil: null }, { status: "active", validUntil: Timestamp.fromMillis(1) }]) {
      await testEnvironment.withSecurityRulesDisabled((context) => setDoc(doc(context.firestore(), "hotelSubscriptions", "hotel-a"), subscription));
      await assertFails(getDoc(product));
    }
    await testEnvironment.withSecurityRulesDisabled((context) => deleteDoc(doc(context.firestore(), "hotelSubscriptions", "hotel-a")));
    await assertFails(getDoc(product));
  });

  it("prevents a hotel member from changing their subscription", async () => {
    await assertFails(setDoc(doc(databaseFor(profiles.hotelAdminA), "hotelSubscriptions", "hotel-a"), { status: "active", validUntil: null }));
  });
  it("requires backend mutations even for platform subscription and audit changes", async () => {
    const database = databaseFor(profiles.platformAdmin);
    await assertFails(setDoc(doc(database, "hotelSubscriptions", "hotel-a"), { status: "active", validUntil: null }));
    await assertFails(setDoc(doc(database, "hotels/hotel-a/subscriptionAudit", "forged"), { status: "active" }));
  });
  it("bootstrap defaults to dry-run, preserves suspended subscriptions and safely reruns", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hotel-subscription-bootstrap-"));
    const file = join(directory, "hotels.json");
    try {
      await writeFile(file, JSON.stringify(["hotel-a", "hotel-b"]));
      await testEnvironment.withSecurityRulesDisabled(async (context) => {
        const database = context.firestore();
        await deleteDoc(doc(database, "hotelSubscriptions", "hotel-a"));
        await setDoc(doc(database, "hotelSubscriptions", "hotel-b"), { status: "suspended", revision: 4 });
        const args = ["scripts/firebase/bootstrap-hotel-subscriptions.mjs", "--project", projectId,
          "--hotel-file", file, "--operator", "fictional-operator"];
        const execute = (extra = []) => promisify(execFile)(process.execPath, [...args, ...extra], { timeout: 30000 });
        await execute();
        assert.equal((await getDoc(doc(database, "hotelSubscriptions", "hotel-a"))).exists(), false);
        await execute(["--apply"]);
        await execute(["--apply"]);
        const created = (await getDoc(doc(database, "hotelSubscriptions", "hotel-a"))).data();
        assert.equal(created.status, "active");
        assert.equal(created.billingMode, "manual");
        assert.equal(created.revision, 1);
        assert.equal((await getDoc(doc(database, "hotelSubscriptions", "hotel-b"))).data().status, "suspended");
        assert.equal((await getDocs(collection(database, "hotels/hotel-a/subscriptionAudit"))).size, 1);
      });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("denies reservation data without reservations.read", async () => {
    const database = databaseFor(profiles.noPermissionsA);
    await assertFails(getDoc(doc(database, "hotels/hotel-a/reports/arrivalsdetailed/2026-10-05", "arrival-a")));
  });

  it("permits reservation report reads but never client report writes", async () => {
    const database = databaseFor(profiles.specialistA);
    const arrival = doc(database, "hotels/hotel-a/reports/arrivalsdetailed/2026-10-05", "arrival-a");
    await assertSucceeds(getDoc(arrival));
    await assertFails(setDoc(arrival, { guest: "Changed" }));
  });

  it("requires backend order approval and prevents direct order mutations", async () => {
    const database = databaseFor(profiles.specialistA);
    const order = doc(database, "hotels/hotel-a/orders", "order-a");
    await assertFails(updateDoc(order, {
      dispatchRequestId: "request-1", dispatchRequestedByEmail: "approver@example.test",
      dispatchStatus: "processing", dispatchProgress: 5, dispatchStep: "requested",
      dispatchError: "", updatedAt: "fixture", updatedBy: profiles.specialistA.uid,
    }));
    await assertFails(updateDoc(order, { totalAmount: 1 }));
  });

  it("allows explicit notify and demand-calendar actions only in hotel A", async () => {
    const database = databaseFor(profiles.specialistA);
    await assertSucceeds(setDoc(doc(database, "hotels/hotel-a/contractReminderRuns", "run-a"), { status: "queued" }));
    await assertSucceeds(setDoc(doc(database, "hotels/hotel-a/demandCalendarEvents", "event-a"), { name: "Fixture" }));
    await assertFails(setDoc(doc(database, "hotels/hotel-b/demandCalendarEvents", "event-b"), { name: "Cross tenant" }));
  });

  it("keeps internal rooming-list history behind internal permissions", async () => {
    const database = databaseFor(profiles.specialistA);
    await assertSucceeds(getDoc(doc(database, "roomingListLinks/public-token-a/versions", "1")));
    await assertSucceeds(setDoc(doc(database, "roomingListLinks/public-token-a/changeRequests", "request-a"), { status: "Approved" }));
  });
});


describe("tenant isolation", () => {
  it("allows the platform administrator to inspect both fictional hotels", async () => {
    const database = databaseFor(profiles.platformAdmin);
    await assertSucceeds(getDoc(doc(database, "hotels/hotel-a/catalogproducts", "product-a")));
    await assertSucceeds(getDoc(doc(database, "hotels/hotel-b/catalogproducts", "product-b")));
  });

  it("allows an employee to read only the assigned hotel", async () => {
    const database = databaseFor(profiles.employeeA);
    await assertSucceeds(getDoc(doc(database, "hotels/hotel-a/catalogproducts", "product-a")));
    await assertFails(getDoc(doc(database, "hotels/hotel-b/catalogproducts", "product-b")));
  });

  it("enforces action permissions in addition to membership", async () => {
    const employeeDatabase = databaseFor(profiles.employeeA);
    await assertFails(setDoc(doc(employeeDatabase, "hotels/hotel-a/catalogproducts", "new"), { name: "Denied" }));

    const adminDatabase = databaseFor(profiles.hotelAdminA);
    await assertSucceeds(setDoc(doc(adminDatabase, "hotels/hotel-a/catalogproducts", "new"), { name: "Allowed" }));
  });

  it("supports different permissions for the same user in hotels A and B", async () => {
    const database = databaseFor(profiles.multiHotelUser);
    await assertSucceeds(getDoc(doc(database, "hotels/hotel-a/catalogproducts", "product-a")));
    await assertFails(setDoc(doc(database, "hotels/hotel-a/catalogproducts", "new"), { name: "Denied" }));
    await assertFails(getDoc(doc(database, "hotels/hotel-b/catalogproducts", "product-b")));
    await assertSucceeds(setDoc(doc(database, "hotels/hotel-b/catalogproducts", "new"), { name: "Allowed" }));
  });
});

describe("global users containment", () => {
  it("allows a user to read only their own profile", async () => {
    const database = databaseFor(profiles.hotelAdminA);
    await assertSucceeds(getDoc(doc(database, "users", profiles.hotelAdminA.uid)));
    await assertFails(getDoc(doc(database, "users", profiles.employeeB.uid)));
    await assertFails(getDocs(collection(database, "users")));
  });

  it("prevents a hotel administrator from granting themselves access", async () => {
    const database = databaseFor(profiles.hotelAdminA);
    await assertFails(updateDoc(doc(database, "users", profiles.hotelAdminA.uid), {
      hotelUid: ["hotel-a", "hotel-b"],
      permissions: ["platform.*"],
    }));
  });

  it("prevents membership self-promotion and delegated privilege escalation", async () => {
    const database = databaseFor(profiles.hotelAdminA);
    await assertFails(updateDoc(doc(database, "hotels/hotel-a/members", profiles.hotelAdminA.uid), {
      permissions: ["users.*", "catalogproducts.*"],
    }));
    await assertFails(updateDoc(doc(database, "hotels/hotel-a/members", profiles.employeeA.uid), {
      permissions: ["platform.*"],
    }));
  });
});

describe("temporary public rooming-list containment", () => {
  it("prevents anonymous discovery of active public tokens through a filtered hotel query", async () => {
    const database = testEnvironment.unauthenticatedContext().firestore();
    await assertFails(getDocs(query(collection(database, "roomingListLinks"), where("hotelUid", "==", "hotel-a"),
      where("publicAccessEnabled", "==", true), where("publicAccessExpiresAt", ">", Timestamp.fromMillis(Date.now() + 1000)))));
  });
  it("keeps root writes separate from child approval permissions and preserves the original tenant", async () => {
    const database = testEnvironment.authenticatedContext(profiles.specialistA.uid, { email_verified: true }).firestore();
    await assertFails(updateDoc(doc(database, "roomingListLinks/public-token-a"), { hotelUid: "hotel-b" }));
    await testEnvironment.withSecurityRulesDisabled((context) => updateDoc(doc(context.firestore(), `hotels/hotel-a/members/${profiles.specialistA.uid}`), { permissions: ["roominglists.update"] }));
    await assertSucceeds(updateDoc(doc(database, "roomingListLinks/public-token-a"), { groupName: "Updated within hotel A" }));
    await assertFails(updateDoc(doc(database, "roomingListLinks/public-token-a"), { hotelUid: "hotel-b" }));
  });
  it("allows only the active token root to be read anonymously", async () => {
    const database = testEnvironment.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(database, "roomingListLinks", "public-token-a")));
    await assertFails(getDoc(doc(database, "roomingListLinks/public-token-a/versions", "1")));
    await assertFails(updateDoc(doc(database, "roomingListLinks", "public-token-a"), {
      reservations: [{ firstName: "External", lastName: "Guest" }],
    }));
  });

  it("denies an unknown token", async () => {
    const database = testEnvironment.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(database, "roomingListLinks", "unknown-token")));
  });
});

describe("default deny", () => {
  it("blocks arbitrary root documents for authenticated and anonymous callers", async () => {
    const authenticatedDatabase = databaseFor(profiles.hotelAdminA);
    const anonymousDatabase = testEnvironment.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(authenticatedDatabase, "unmapped", "sensitive")));
    await assertFails(setDoc(doc(authenticatedDatabase, "unmapped", "sensitive"), { exposed: true }));
    await assertFails(getDoc(doc(anonymousDatabase, "unmapped", "sensitive")));
    await assertFails(setDoc(doc(anonymousDatabase, "unmapped", "sensitive"), { exposed: true }));
  });

  it("blocks an uncatalogued hotel collection for a normal member", async () => {
    const database = databaseFor(profiles.hotelAdminA);
    await assertFails(getDoc(doc(database, "hotels/hotel-a/reports", "guest-data")));
  });
});
