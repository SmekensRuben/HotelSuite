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

test("updateUserAccess writes profiles, memberships and Storage token permissions", async () => {
  const operations = [];
  const firestore = {
    doc: (path) => ({ path }),
    batch: () => ({
      update: (reference, data) => operations.push(["update", reference.path, data]),
      set: (reference, data) => operations.push(["set", reference.path, data]),
      delete: (reference) => operations.push(["delete", reference.path]),
      commit: async () => operations.push(["commit"]),
    }),
  };
  let claims;
  const auth = {
    getUser: async () => ({ customClaims: { platformAdmin: false, retained: true } }),
    setCustomUserClaims: async (uid, value) => { claims = { uid, value }; },
  };

  const result = await updateUserAccessHandler({
    auth: { uid: "platform", token: { platformAdmin: true } },
    data: {
      userId: "user-a",
      profile: { firstName: " Ada ", lastName: "Lovelace", email: "ada@example.test", hotelUid: ["hotel-a"] },
      memberships: { "hotel-a": ["reservations.read"] },
      previousHotelUids: ["hotel-a", "hotel-b"],
    },
  }, { firestore, auth });

  assert.equal(operations.some(([type, path]) => type === "set" && path === "hotels/hotel-a/members/user-a"), true);
  assert.equal(operations.some(([type, path]) => type === "delete" && path === "hotels/hotel-b/members/user-a"), true);
  assert.deepEqual(claims, {
    uid: "user-a",
    value: { platformAdmin: false, retained: true, hotelPermissions: { "hotel-a": ["reservations.read"] } },
  });
  assert.equal(result.tokenRefreshRequired, true);
});
