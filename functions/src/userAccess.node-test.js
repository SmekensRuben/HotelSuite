const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeMemberships, updateUserAccessHandler } = require("./userAccess");

test("normalizeMemberships keeps permissions separate per hotel", () => {
  assert.deepEqual(normalizeMemberships(["hotel-a", "hotel-b"], {
    "hotel-a": ["reservations.read", "reservations.read"],
    "hotel-b": ["orders.read"],
  }), {
    "hotel-a": ["reservations.read"],
    "hotel-b": ["orders.read"],
  });
});

test("updateUserAccess requires a platform administrator", async () => {
  await assert.rejects(
    updateUserAccessHandler({ auth: { uid: "hotel-admin", token: {} }, data: {} }),
    (error) => error.code === "permission-denied",
  );
});

test("updateUserAccess writes profiles, memberships and server-owned membership removals", async () => {
  const operations = [];
  const firestore = {
    doc: (path) => ({ path }),
    collection: () => ({ doc: () => ({ path: "userAccessAudit/event" }) }),
    runTransaction: (callback) => callback({
      get: async (reference) => ({ exists: true, data: () => reference.path === "users/user-a" ? { hotelUid: ["hotel-a", "hotel-b"], accessRevision: 0 } : {} }),
      update: (reference, data) => operations.push(["update", reference.path, data]),
      set: (reference, data) => operations.push(["set", reference.path, data]),
      delete: (reference) => operations.push(["delete", reference.path]),
    }),
  };
  let claims;
  const auth = {
    getUser: async (uid) => uid === "platform" ? { emailVerified: true, customClaims: { platformAdmin: true } } : { customClaims: { platformAdmin: false, retained: true } },
    setCustomUserClaims: async (uid, value) => { claims = { uid, value }; },
  };

  const result = await updateUserAccessHandler({
    auth: { uid: "platform", token: { platformAdmin: true, email_verified: true } },
    data: {
      userId: "user-a",
      profile: { firstName: " Ada ", lastName: "Lovelace", email: "ada@example.test", hotelUid: ["hotel-a"] },
      memberships: { "hotel-a": ["reservations.read"] },
      previousHotelUids: [], // The browser cannot choose which old memberships to retain.
      expectedAccessRevision: 0,
    },
  }, { firestore, auth });

  assert.equal(operations.some(([type, path]) => type === "set" && path === "hotels/hotel-a/members/user-a"), true);
  assert.equal(operations.some(([type, path]) => type === "delete" && path === "hotels/hotel-b/members/user-a"), true);
  assert.equal(claims, undefined);
  assert.equal(result.accessRevision, 1);
});

test("stale user access saves cannot overwrite a more recent assignment", async () => {
  const firestore = {
    doc: (path) => ({ path }), collection: () => ({ doc: () => ({}) }),
    runTransaction: (callback) => callback({ get: async () => ({ exists: true, data: () => ({ accessRevision: 3 }) }) }),
  };
  await assert.rejects(updateUserAccessHandler({
    auth: { uid: "platform", token: { platformAdmin: true, email_verified: true } },
    data: { userId: "user-a", profile: { hotelUid: [] }, expectedAccessRevision: 2 },
  }, { firestore, auth: { getUser: async () => ({ emailVerified: true, customClaims: { platformAdmin: true } }) } }), (error) => error.code === "aborted");

});
