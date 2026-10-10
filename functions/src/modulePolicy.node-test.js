const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { moduleAllows, featureIsLicensed, compileMemberAccess, validateSeatLimit, dataPathModule, catalog } = require("./modulePolicy");
const { requireHotelPermission } = require("./authorization");
const subscription = { modulePolicyVersion: 1, modules: ["procurement"] };

test("missing, malformed and future module policies fail closed; plan names do not grant modules", () => {
  for (const invalid of [{ planId: "all-modules" }, { ...subscription, modulePolicyVersion: 2 },
    { ...subscription, modules: ["procurement", "procurement"] }, { ...subscription, modules: ["unknown"] }, { ...subscription, modules: "procurement" }]) {
    assert.equal(moduleAllows(invalid, "procurement"), false);
    assert.equal(featureIsLicensed(invalid, "users"), false);
  }
  assert.equal(featureIsLicensed(subscription, "ORDERS"), true);
  assert.equal(featureIsLicensed(subscription, "contracts"), false);
  assert.equal(featureIsLicensed(subscription, "users"), true);
  assert.equal(featureIsLicensed(subscription, "super"), false);
});
test("hotel administration conveys delegation without automatic operational or platform grants", () => {
  const access = compileMemberAccess({ hotelAdmin: true }, subscription);
  assert.deepEqual(access.permissions, ["dashboard.read", "users.create", "users.delete", "users.read", "users.update"]);
  assert.equal(access.permissions.some((key) => key.startsWith("orders.") || key.startsWith("super.")), false);
});
test("role combinations use explicit action grants and module managers do not automatically approve", () => {
  const access = compileMemberAccess({ moduleRoles: { procurement: ["buyer", "approver"] } }, subscription);
  assert.ok(access.permissions.includes("orders.create"));
  assert.ok(access.permissions.includes("orders.approve"));
  assert.equal(access.permissions.some((key) => key.endsWith(".*")), false);
  const manager = compileMemberAccess({ moduleRoles: { procurement: ["module-manager"] } }, subscription);
  assert.ok(manager.permissions.includes("suppliers.password"));
  assert.equal(manager.permissions.includes("orders.approve"), false);
  assert.equal(manager.permissions.includes("users.create"), false);
  for (const role of Object.values(catalog.modules.procurement.roles)) assert.equal(role.permissions.some((key) => key.includes("contracts") || key.includes("groupquotes")), false);
});
test("advanced grants and role selections cannot bypass subscriptions or grant user/platform administration", () => {
  for (const selection of [{ additionalPermissions: ["contracts.*"] }, { additionalPermissions: ["super.admin"] },
    { additionalPermissions: ["users.*"] }, { moduleRoles: { procurement: ["unknown"] } }, { moduleRoles: { procurement: ["buyer", "buyer"] } }]) {
    assert.throws(() => compileMemberAccess(selection, subscription));
  }
  assert.throws(() => compileMemberAccess({ moduleRoles: { procurement: ["buyer"] } }, { ...subscription, modules: [] }), (error) => error.code === "permission-denied");
});
test("dormant existing custom rights and roles can be retained without granting new unlicensed access", () => {
  const dormant = { ...subscription, modules: [] };
  const existing = ["orders.read", "orders.create", "auditUpsells.read"];
  const access = compileMemberAccess({ moduleRoles: { procurement: ["buyer"] }, additionalPermissions: ["auditupsells.read"] },
    dormant, existing, { procurement: ["buyer"] });
  assert.ok(access.permissions.includes("orders.create"));
  assert.equal(access.permissions.includes("orders.update"), false, "do not recompile new dormant role grants");
  assert.equal(featureIsLicensed(dormant, "orders"), false);
  assert.throws(() => compileMemberAccess({ additionalPermissions: ["orders.approve"] }, dormant, existing));
});
test("seat limits are explicit and bounded", () => {
  assert.equal(validateSeatLimit(null), null);
  assert.equal(validateSeatLimit(20), 20);
  for (const value of [0, -1, 2.5, "20", undefined, NaN, Infinity, 10001]) assert.throws(() => validateSeatLimit(value));
});
test("ordinary action and wildcard permissions cannot authorize an unlicensed module", async () => {
  const auth = { getUser: async () => ({ emailVerified: true, disabled: false }) };
  const db = { doc: (documentPath) => ({ get: async () => ({ exists: true,
    data: () => documentPath.startsWith("hotelSubscriptions") ? { ...subscription, status: "active", validUntil: null } : { permissions: ["orders.*", "contracts.*"] } }) }) };
  const request = { auth: { uid: "member", token: { email_verified: true } } };
  await requireHotelPermission(db, request, "hotel-a", "orders", "read", undefined, auth);
  await assert.rejects(requireHotelPermission(db, request, "hotel-a", "contracts", "read", undefined, auth), (error) => error.code === "permission-denied");
});
test("import target modules come from canonical destinations, not source module declarations", () => {
  assert.equal(dataPathModule("hotels/hotel-a/reports/historyforecast/2026"), "revenue");
  assert.equal(dataPathModule("hotels/hotel-a/reports/reservationdetails/2026"), "frontoffice");
  assert.equal(dataPathModule("hotels/hotel-a/catalogproducts/item"), "procurement");
  assert.equal(dataPathModule("hotelSubscriptions/hotel-a"), null);
  assert.equal(dataPathModule("hotels/hotel-a/memberAdministration/state"), null);
});
test("generated Firestore and Storage module boundaries match the shared catalog", () => {
  execFileSync(process.execPath, [path.resolve(__dirname, "../../scripts/render-module-rules.mjs"), "--check"]);
});
