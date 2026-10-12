const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildHotelSetupReport, validTimeZone } = require("./hotelSetupPolicy");

function fixture() {
  return { hotelUid: "hotel-a", hotel: { timeZone: "Europe/Brussels", password: "private" },
    subscription: { status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1, billingMode: "manual", seatLimit: null },
    releaseReady: true, bootstrap: { currency: "EUR" }, truncated: false,
    members: ["one", "two"].map((id) => ({ id, data: { hotelAdmin: true, permissions: id === "one" ? ["orders.*", "orders.receive", "orders.finalize", "stockcounts.read", "stockcounts.create"] : ["users.read"] } })),
    profiles: ["one", "two"].map((id) => ({ id, data: { hotelUid: ["hotel-a", "private-hotel"], password: "private" } })),
    identities: ["one", "two"].map((uid) => ({ uid, emailVerified: true, disabled: false, customClaims: { secret: "private" } })),
    outlets: [{ id: "bar", data: {} }], suppliers: [{ id: "supplier", data: { password: "private" } }],
    products: [{ id: "coffee", data: { supplierId: "supplier", active: true, pricePerPurchaseUnit: 0, currency: "EUR", purchaseUnit: "box" } }],
    locations: [{ id: "store", data: {} }], stockTemplateLocations: 1, approverUids: ["one"], importTypes: [], monitors: [], invitations: [] };
}
const check = (report, id) => report.checks.find((item) => item.id === id);
test("complete verified setup is ready; imports are genuinely not applicable without a source", () => {
  const report = buildHotelSetupReport(fixture(), 100);
  assert.equal(report.status, "ready");
  assert.equal(report.computedAtMillis, 100);
  assert.equal(check(report, "imports").status, "not-applicable");
  assert.equal(report.integrity.issueCount, 0);
  assert.equal(JSON.stringify(report).includes("private"), false);
});
test("the actual orphan blocks setup without inventing a profile or Auth account", () => {
  const raw = fixture();
  raw.members.push({ id: "deleted-user", data: { permissions: [] } });
  const before = JSON.stringify(raw);
  const report = buildHotelSetupReport(raw);
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.integrity.issues, [{ uid: "deleted-user", codes: ["auth-account-missing", "profile-missing"] }]);
  assert.equal(JSON.stringify(raw), before);
});
test("profile-only assignments and mismatched member profiles are independently detected", () => {
  const raw = fixture();
  raw.profiles[0].data.hotelUid = ["private-hotel"];
  raw.profiles.push({ id: "unassigned", data: { hotelUid: ["hotel-a"] } });
  raw.identities.push({ uid: "unassigned", emailVerified: true });
  const report = buildHotelSetupReport(raw);
  assert.deepEqual(report.integrity.issues, [{ uid: "one", codes: ["profile-assignment-mismatch"] }, { uid: "unassigned", codes: ["membership-missing"] }]);
  assert.equal(check(report, "administrators").status, "pending");
});
test("unverified/disabled administrators do not count; invitation processing is not verification", () => {
  for (const state of [{ disabled: true }, { emailVerified: false }]) {
    const raw = fixture(); Object.assign(raw.identities[1], state);
    raw.invitations = [{ id: "invite", uid: "two", status: "sent", createdAtMillis: 1 }];
    const report = buildHotelSetupReport(raw);
    assert.equal(report.status, "incomplete");
    assert.equal(check(report, "administrators").status, "pending");
  }
});
test("bounded inspection is unknown and never a successful empty inspection", () => {
  const raw = fixture(); raw.truncated = true;
  const report = buildHotelSetupReport(raw);
  assert.equal(report.status, "unknown");
  assert.equal(report.integrity.inspectionTruncated, true);
  assert.equal(check(report, "integrity").status, "unknown");
});
test("expired or absent module policies and paused release block setup", () => {
  for (const patch of [{ releaseReady: false }, { subscription: { status: "active" } },
    { subscription: { ...fixture().subscription, status: "suspended" } },
    { subscription: { ...fixture().subscription, validUntil: { toMillis: () => 99 } } },
    { subscription: { ...fixture().subscription, seatLimit: 0 } }]) {
    assert.equal(buildHotelSetupReport({ ...fixture(), ...patch }, 100).status, "blocked");
  }
});
test("admin-only members, unusable products and missing property settings remain incomplete", () => {
  for (const mutate of [raw => { raw.members.forEach((row) => { row.data.permissions = ["users.read"]; }); },
    raw => { raw.products[0].data.pricePerPurchaseUnit = null; }, raw => { raw.hotel.timeZone = ""; },
    raw => { raw.bootstrap.currency = ""; }, raw => { raw.approverUids = []; }, raw => { raw.stockTemplateLocations = 0; }]) {
    const raw = fixture(); mutate(raw); assert.equal(buildHotelSetupReport(raw).status, "incomplete");
  }
});
test("every enabled import requires a matching validated active schedule", () => {
  const raw = fixture(); raw.importTypes = [{ id: "source", data: { fileType: "forecast", enabled: true } }];
  assert.equal(check(buildHotelSetupReport(raw), "imports").status, "pending");
  const policy = { fileType: "forecast", label: "Forecast", timeZone: "Europe/Brussels", expectedBy: "07:00", graceMinutes: 30,
    weekdays: [1, 2], businessDateOffsetDays: -1, startsOn: "2026-10-12", enabled: true, paused: false, acceptEmpty: false };
  raw.monitors = [{ id: "source", data: policy }];
  assert.equal(check(buildHotelSetupReport(raw), "imports").status, "ready");
  for (const bad of [{ paused: true }, { weekdays: [] }, { fileType: "another" }]) {
    raw.monitors[0].data = { ...policy, ...bad };
    assert.equal(check(buildHotelSetupReport(raw), "imports").status, "pending");
  }
});
test("member data cannot spoof another member's document identity", () => {
  const raw = fixture(); raw.members[0].data.uid = "spoof";
  raw.approverUids = ["spoof"];
  assert.equal(check(buildHotelSetupReport(raw), "procurement.roles").status, "pending");
});
test("invalid permissions and oversized Auth IDs are explicit findings", () => {
  const raw = fixture(); raw.members[1].data.permissions = ["super.admin"];
  raw.invalidUserIds = ["two"];
  assert.deepEqual(buildHotelSetupReport(raw).integrity.issues[0].codes, ["invalid-user-id", "membership-permissions-invalid"]);
  assert.equal(validTimeZone("Invalid/zone"), false);
  assert.equal(validTimeZone("Europe/Brussels"), true);
});
test("retained platform-only profile links do not falsely require an employee membership", () => {
  const raw = fixture(); raw.profiles.push({ id: "operator", data: { hotelUid: ["hotel-a"] } });
  raw.identities.push({ uid: "operator", platformAdmin: true, emailVerified: true });
  assert.equal(buildHotelSetupReport(raw).status, "ready");
  assert.equal(buildHotelSetupReport(raw).integrity.issueCount, 0);
});
test("legacy order wildcard is not a grant of the new receiving capabilities", () => {
  const raw = fixture(); raw.members[0].data.permissions = ["orders.*", "stockcounts.read", "stockcounts.create"];
  assert.equal(buildHotelSetupReport(raw).checks.find((item) => item.id === "procurement.roles").status, "pending");
});
test("a large catalog can prove basic setup from a usable bounded sample without claiming global totals", () => {
  const raw = fixture(); raw.sourceSampleTruncated = true;
  assert.equal(buildHotelSetupReport(raw).status, "ready");
  assert.match(buildHotelSetupReport(raw).checks.find((item) => item.id === "procurement.sources").detail, /Bounded sample: at least/);
  raw.products = [];
  assert.equal(buildHotelSetupReport(raw).status, "unknown");
  assert.equal(buildHotelSetupReport(raw).integrity.inspectionTruncated, false);
});
test("uninspected import sources and approvers cannot be accepted as absent or configured", () => {
  const raw = fixture(); raw.importsTruncated = true;
  assert.equal(buildHotelSetupReport(raw).status, "unknown");
  raw.importsTruncated = false; raw.approversTruncated = true; raw.approverUids = [];
  assert.equal(buildHotelSetupReport(raw).status, "unknown");
});
test("a stock creator who cannot read the count does not cover the operational workflow", () => {
  const raw = fixture(); raw.members[0].data.permissions = raw.members[0].data.permissions.filter((key) => key !== "stockcounts.read");
  assert.equal(buildHotelSetupReport(raw).status, "incomplete");
});
