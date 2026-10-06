const test = require("node:test");
const assert = require("node:assert/strict");
const { permissionAllows, requireHotelPermission } = require("./authorization");

test("permissionAllows accepts exact and feature wildcard permissions", () => {
  assert.equal(permissionAllows(["orders.read"], "orders", "read"), true);
  assert.equal(permissionAllows(["orders.*"], "orders", "approve"), true);
  assert.equal(permissionAllows(["orders.read"], "orders", "approve"), false);
  assert.equal(permissionAllows(["super.admin"], "orders", "approve"), true);
});

test("super.admin bypasses hotel action checks but still uses the selected membership", async () => {
  const db = {
    doc(path) {
      return { async get() {
        assert.equal(path, "hotels/hotel-a/members/super-a");
        return { exists: true, data: () => ({ permissions: ["super.admin"] }) };
      } };
    },
  };
  await assert.doesNotReject(requireHotelPermission(db, {
    auth: { uid: "super-a", token: {} },
  }, "hotel-a", "reservations", "read"));
});

test("requireHotelPermission uses the selected hotel's membership", async () => {
  const db = {
    doc(path) {
      return {
        async get() {
          assert.equal(path, "hotels/hotel-a/members/user-a");
          return { exists: true, data: () => ({ permissions: ["reservations.read"] }) };
        },
      };
    },
  };
  await assert.doesNotReject(requireHotelPermission(db, { auth: { uid: "user-a", token: {} } }, "hotel-a", "reservations", "read"));
  await assert.rejects(
    requireHotelPermission(db, { auth: { uid: "user-a", token: {} } }, "hotel-a", "reservations", "update"),
    (error) => error.code === "permission-denied",
  );
});

test("platform administrators bypass hotel membership", async () => {
  const db = { doc: () => { throw new Error("membership should not be read"); } };
  await assert.doesNotReject(requireHotelPermission(db, {
    auth: { uid: "platform", token: { platformAdmin: true } },
  }, "hotel-b", "users", "update"));
});
