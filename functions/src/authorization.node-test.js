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
          if (path === "hotelSubscriptions/hotel-a") return { exists: true, data: () => ({ status: "active", validUntil: null }) };
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

test("platform administrators bypass hotel membership", async () => {
  const db = { doc: () => { throw new Error("membership should not be read"); } };
  await assert.doesNotReject(requireHotelPermission(db, {
    auth: { uid: "platform", token: { platformAdmin: true, email_verified: true } },
  }, "hotel-b", "users", "update", undefined, currentAuth));
});
