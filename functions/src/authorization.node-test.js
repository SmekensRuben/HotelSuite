const test = require("node:test");
const assert = require("node:assert/strict");
const currentAuth = { getUser: async () => ({ emailVerified: true, customClaims: { platformAdmin: true } }) };
const { permissionAllows, requireHotelPermission } = require("./authorization");

test("permissionAllows accepts exact and feature wildcard permissions", () => {
  assert.equal(permissionAllows(["orders.read"], "orders", "read"), true);
  assert.equal(permissionAllows(["orders.*"], "orders", "approve"), true);
  assert.equal(permissionAllows(["orders.read"], "orders", "approve"), false);
});

test("requireHotelPermission uses the selected hotel's membership", async () => {
  const db = {
    doc(path) {
      return {
        async get() {
          if (path === "hotelSubscriptions/hotel-a") return { exists: true, data: () => ({ modules: ["procurement", "contracts", "frontoffice", "groups", "revenue"], modulePolicyVersion: 1, status: "active", validUntil: null }) };
          assert.equal(path, "hotels/hotel-a/members/user-a");
          return { exists: true, data: () => ({ permissions: ["reservations.read"] }) };
        },
      };
    },
  };
  await assert.doesNotReject(requireHotelPermission(db, { auth: { uid: "user-a", token: { email_verified: true } } }, "hotel-a", "reservations", "read", undefined, currentAuth));
  await assert.rejects(
    requireHotelPermission(db, { auth: { uid: "user-a", token: { email_verified: true } } }, "hotel-a", "reservations", "update", undefined, currentAuth),
    (error) => error.code === "permission-denied",
  );
});

test("platform authority grants no operational hotel access without membership", async () => {
  const db = { doc: () => ({ get: async () => ({ exists: false }) }) };
  await assert.rejects(requireHotelPermission(db, {
    auth: { uid: "platform", token: { platformAdmin: true, email_verified: true } },
  }, "hotel-b", "users", "update", undefined, currentAuth), (error) => error.code === "permission-denied");
});
