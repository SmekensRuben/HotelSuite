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
test("manual movements are licensed separately and only supervisors explicitly reverse them", () => {
  assert.equal(featureIsLicensed(subscription, "inventorymovements"), true);
  assert.equal(featureIsLicensed({ ...subscription, modules: [] }, "inventorymovements"), false);
  const counter = compileMemberAccess({ moduleRoles: { procurement: ["stock-controller"] } }, subscription);
  assert.ok(counter.permissions.includes("inventorymovements.create"));
  assert.equal(counter.permissions.includes("inventorymovements.reverse"), false);
  const supervisor = compileMemberAccess({ moduleRoles: { procurement: ["inventory-supervisor"] } }, subscription);
  assert.ok(supervisor.permissions.includes("inventorymovements.reverse"));
  assert.equal(supervisor.permissions.includes("supplierproducts.read"), false);
  const { permissionAllows } = require("./authorization");
  assert.equal(permissionAllows(["inventorymovements.*"], "inventorymovements", "reverse"), false);
  assert.equal(permissionAllows(["inventorymovements.reverse"], "inventorymovements", "reverse"), true);
});
test("purchase request roles separate requesting, approval and budget authority behind explicit grants", () => {
  const { permissionAllows } = require("./authorization");
  for (const feature of ["purchaserequests", "purchasebudgets"]) {
    assert.equal(featureIsLicensed(subscription, feature), true);
    assert.equal(featureIsLicensed({ ...subscription, modules: [] }, feature), false);
  }
  const requester = compileMemberAccess({ moduleRoles: { procurement: ["purchase-requester"] } }, subscription);
  assert.ok(requester.permissions.includes("purchaserequests.submit"));
  assert.ok(requester.permissions.includes("purchaserequests.cancel"));
  assert.equal(requester.permissions.includes("purchaserequests.approve"), false);
  assert.equal(requester.permissions.includes("purchasebudgets.update"), false);
  const approver = compileMemberAccess({ moduleRoles: { procurement: ["purchase-approver"] } }, subscription);
  assert.ok(approver.permissions.includes("purchaserequests.approve"));
  assert.equal(approver.permissions.includes("purchasebudgets.settings"), false);
  const manager = compileMemberAccess({ moduleRoles: { procurement: ["budget-manager"] } }, subscription);
  assert.ok(manager.permissions.includes("purchasebudgets.settings"));
  assert.equal(manager.permissions.includes("purchaserequests.approve"), false);
  for (const role of ["viewer", "buyer", "approver", "module-manager"]) {
    const legacy = compileMemberAccess({ moduleRoles: { procurement: [role] } }, subscription);
    assert.equal(legacy.permissions.includes("purchaserequests.approve"), false);
    assert.equal(legacy.permissions.includes("purchasebudgets.settings"), false);
  }
  for (const action of ["submit", "approve", "cancel", "selfapprove", "recover"]) {
    assert.equal(permissionAllows(["purchaserequests.*"], "purchaserequests", action), false);
    assert.equal(permissionAllows([`purchaserequests.${action}`], "purchaserequests", action), true);
  }
  assert.equal(permissionAllows(["purchasebudgets.*"], "purchasebudgets", "settings"), false);
  assert.equal(permissionAllows(["purchasebudgets.settings"], "purchasebudgets", "settings"), true);
});
test("recovery managers need explicit licensed authority without inheriting financial decisions", () => {
  const { permissionAllows } = require("./authorization");
  const recovery = compileMemberAccess({ moduleRoles: { procurement: ["purchase-recovery-manager"] } }, subscription);
  assert.ok(recovery.permissions.includes("purchaserequests.recover"));
  assert.ok(recovery.permissions.includes("purchaserequests.read"));
  const orderRecovery = compileMemberAccess({ moduleRoles: { procurement: ["order-delivery-recovery-manager"] } }, subscription);
  assert.deepEqual(orderRecovery.permissions, ["dashboard.read", "orders.read", "orders.recover"]);
  for (const action of ["approve", "selfapprove", "submit", "cancel"]) assert.equal(permissionAllows(recovery.permissions, "purchaserequests", action), false);
  for (const action of ["update", "settings"]) assert.equal(permissionAllows(recovery.permissions, "purchasebudgets", action), false);
  for (const feature of ["purchaserequests", "orders"]) {
    assert.equal(permissionAllows([`${feature}.*`, `${feature}.approve`], feature, "recover"), false);
    assert.equal(permissionAllows([`${feature}.recover`], feature, "recover"), true);
    assert.throws(() => compileMemberAccess({ additionalPermissions: [`${feature}.recover`] }, { ...subscription, modules: [] }), { code: "permission-denied" });
  }
  for (const role of ["module-manager", "purchase-approver", "budget-manager", "approver"]) {
    const access = compileMemberAccess({ moduleRoles: { procurement: [role] } }, subscription);
    assert.equal(access.permissions.some((key) => key.endsWith(".recover")), false);
  }
  assert.equal(compileMemberAccess({ hotelAdmin: true }, subscription).permissions.some((key) => key.endsWith(".recover")), false);
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
  for (const name of ["purchaseRequests", "purchaseBudgets", "purchaseRequestOperations", "purchaseRequestAttachments", "purchaseRequestNotifications", "settings/purchaseRequests"])
    assert.equal(dataPathModule(`hotels/hotel-a/${name}/record`), "procurement");
});
test("generated Firestore and Storage module boundaries match the shared catalog", () => {
  execFileSync(process.execPath, [path.resolve(__dirname, "../../scripts/render-module-rules.mjs"), "--check"]);
});
