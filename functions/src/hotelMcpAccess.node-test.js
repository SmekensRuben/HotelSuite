const test = require("node:test");
const assert = require("node:assert/strict");
const { requireMcpHotelPermission, discoverMcpHotelsHandler } = require("./hotelMcpAccess");
const { SAAS_RULES_VERSION } = require("./saasRollout");

function fixture() {
  const records = new Map([
    ["platformConfiguration/saasProcurement", { enabled: true, rulesVersion: SAAS_RULES_VERSION }],
    ["users/user", { hotelUid: ["hotel-a", "hotel-b", "removed", "suspended"] }],
    ["hotels/hotel-a", { hotelName: "Accessible hotel", privateContact: "Not returned" }],
    ["hotels/hotel-b", { hotelName: "Other hotel" }],
    ["hotels/removed", { hotelName: "Removed hotel" }],
    ["hotels/suspended", { hotelName: "Suspended hotel" }],
    ["hotels/hotel-a/members/user", { permissions: ["catalogproducts.read", "catalogproducts.create", "supplierproducts.read", "suppliers.read"] }],
    ["hotels/hotel-b/members/user", { permissions: ["orders.read"] }],
    ["hotels/suspended/members/user", { permissions: ["catalogproducts.read"] }],
    ...["hotel-a", "hotel-b", "removed", "suspended"].map((id) => [`hotelSubscriptions/${id}`, { status: id === "suspended" ? "suspended" : "active", modules: ["procurement"], modulePolicyVersion: 1, validUntil: null }]),
  ]);
  const reads = [];
  const db = { doc: (path) => ({ path, get: async () => { reads.push(path); return { exists: records.has(path), data: () => records.get(path) }; } }) };
  let user = { uid: "user", emailVerified: true, customClaims: {} };
  const auth = { getUser: async () => user };
  const request = (data = {}) => ({ auth: { uid: "user", token: { email_verified: true, auth_time: 100 } }, data });
  return { db, auth, records, reads, request, setUser: (next) => { user = next; } };
}

test("MCP hotel discovery returns only current operational product memberships and minimal hotel context", async () => {
  const f = fixture();
  const result = await discoverMcpHotelsHandler(f.request(), { firestore: f.db, auth: f.auth });
  assert.deepEqual(result, { hotels: [{ hotelUid: "hotel-a", name: "Accessible hotel",
    productActions: { catalog: ["read", "create"], supplier: ["read"] },
    references: { suppliers: true, categories: true, mappings: true } }], requiresExplicitHotel: true });
  assert.equal(f.reads.includes("hotels/hotel-b"), false);
  assert.equal(f.reads.includes("hotels/removed"), false);
});

test("MCP discovery does not accept a user ID, inferred destination or arbitrary query", async () => {
  const f = fixture();
  for (const data of [{ userId: "other" }, { hotelUid: "hotel-b" }, { path: "hotels" }]) {
    await assert.rejects(discoverMcpHotelsHandler(f.request(data), { firestore: f.db, auth: f.auth }), { code: "invalid-argument" });
  }
  assert.deepEqual(f.reads, []);
});

test("discovery does not advertise product writes that cannot read and review the resulting proposals", async () => {
  const f = fixture();
  f.records.set("hotels/hotel-a/members/user", { permissions: ["catalogproducts.create", "supplierproducts.update"] });
  assert.deepEqual((await discoverMcpHotelsHandler(f.request(), { firestore: f.db, auth: f.auth })).hotels, []);
});

test("MCP product access follows the explicit hotel and current action permission", async () => {
  const f = fixture();
  await requireMcpHotelPermission(f.db, f.request(), "hotel-a", "catalogproducts", "create", undefined, { auth: f.auth });
  for (const [hotelUid, feature, action] of [["hotel-b", "catalogproducts", "read"], ["hotel-a", "catalogproducts", "update"], ["hotel-a", "orders", "create"], ["hotel-a", "suppliers", "update"]]) {
    await assert.rejects(requireMcpHotelPermission(f.db, f.request(), hotelUid, feature, action, undefined, { auth: f.auth }), { code: "permission-denied" });
  }
});

test("platform administration never discovers or authorizes operational hotels by itself", async () => {
  const f = fixture();
  f.records.delete("hotels/hotel-a/members/user");
  f.setUser({ uid: "user", emailVerified: true, customClaims: { platformAdmin: true } });
  const request = f.request(); request.auth.token.platformAdmin = true;
  assert.deepEqual((await discoverMcpHotelsHandler(request, { firestore: f.db, auth: f.auth })).hotels, []);
  await assert.rejects(requireMcpHotelPermission(f.db, request, "hotel-a", "catalogproducts", "read", undefined, { auth: f.auth }), { code: "permission-denied" });
});

test("MCP access stops after membership removal or module subscription withdrawal", async () => {
  const f = fixture();
  const check = () => requireMcpHotelPermission(f.db, f.request(), "hotel-a", "catalogproducts", "read", undefined, { auth: f.auth });
  await check();
  f.records.delete("hotels/hotel-a/members/user");
  await assert.rejects(check(), { code: "permission-denied" });
  f.records.set("hotels/hotel-a/members/user", { permissions: ["catalogproducts.read"] });
  f.records.get("hotelSubscriptions/hotel-a").modules = [];
  await assert.rejects(check(), { code: "permission-denied" });
});

test("disabled, unverified and revoked Firebase accounts cannot use an existing product connection", async () => {
  const f = fixture();
  for (const change of [{ disabled: true }, { emailVerified: false }, { tokensValidAfterTime: new Date(200_000).toISOString() }]) {
    f.setUser({ uid: "user", emailVerified: true, ...change });
    await assert.rejects(requireMcpHotelPermission(f.db, f.request(), "hotel-a", "catalogproducts", "read", undefined, { auth: f.auth }), { code: "permission-denied" });
  }
});

test("OAuth connection consent limits product actions and revocation is checked on every data action", async () => {
  const f = fixture();
  let active = true, checks = 0;
  const grant = { scopes: ["hotel-toolkit:read"], assertActive: async () => { checks += 1; if (!active) throw Object.assign(new Error("Revoked"), { code: "permission-denied" }); } };
  const request = { ...f.request(), mcpAuth: grant };
  await requireMcpHotelPermission(f.db, request, "hotel-a", "catalogproducts", "read", undefined, { auth: f.auth });
  await assert.rejects(requireMcpHotelPermission(f.db, request, "hotel-a", "catalogproducts", "create", undefined, { auth: f.auth }), { code: "permission-denied" });
  active = false;
  await assert.rejects(requireMcpHotelPermission(f.db, request, "hotel-a", "catalogproducts", "read", undefined, { auth: f.auth }), /Revoked/);
  assert.equal(checks, 2);
});

test("transactional MCP authorization reads the live membership and subscription inside the transaction", async () => {
  const f = fixture();
  const reads = [];
  const transaction = { get: async (ref) => { reads.push(ref.path); return ref.get(); } };
  await requireMcpHotelPermission(f.db, f.request(), "hotel-a", "catalogproducts", "create", transaction, { auth: f.auth });
  assert.deepEqual(reads, ["platformConfiguration/saasProcurement", "hotels/hotel-a/members/user", "hotelSubscriptions/hotel-a"]);
});
