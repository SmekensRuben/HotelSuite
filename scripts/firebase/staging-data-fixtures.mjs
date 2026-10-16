import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const STAGING_PROJECT = "hotel-toolkit-staging";
export const EMULATOR_PROJECT = "demo-hotel-toolkit-staging";
export const DATASET_ID = "staging-procurement-v1";
export const HOTEL_IDS = ["staging-hotel-a", "staging-hotel-b"];
export const MANIFEST_PATH = `stagingDataSeeds/${DATASET_ID}`;
export const PROVENANCE = Object.freeze({ datasetId: DATASET_ID, synthetic: true, version: 1 });
export const ROLES = ["admin", "purchaser", "approver", "counter", "revoked"];
export const userId = (hotelUid, role) => `${hotelUid}-${role}`;
export const ownsFixture = (data) => data?.stagingData?.datasetId === DATASET_ID && data?.stagingData?.synthetic === true && data?.stagingData?.version === 1;

export function fixtureUsers() {
  return HOTEL_IDS.flatMap((hotelUid) => ROLES.map((role) => ({ uid: userId(hotelUid, role), hotelUid, role,
    email: `${userId(hotelUid, role)}@example.invalid`, displayName: `STAGING ${hotelUid.endsWith("a") ? "A" : "B"} ${role}`, emailVerified: true })));
}

// Reuse the real, validated purchasing/inventory examples; references remain local
// to each hotel, including supplier SKU reservations, receipt chains and counts.
export function buildStagingData({ businessDate } = {}) {
  businessDate ??= require("../../functions/src/importMonitoringPolicy").localDate(Date.now(), "Europe/Brussels");
  const { buildDemoData } = require("../../functions/src/demoDataFixtures");
  const { TEST_HOTEL_UID } = require("../../functions/src/demoDataPolicy");
  const { admin } = require("../../functions/src/config");
  const { purchaseRequestInternals: { canonicalDigest } } = require("../../functions/src/purchaseRequests");
  const policy = require("../../functions/src/purchaseRequestPolicy");
  const modules = require("../../functions/src/moduleCatalog.json");
  const catalog = require("../../functions/src/permissionCatalog.json");
  const docs = [], users = fixtureUsers(), month = businessDate.slice(0, 7);
  const stamp = admin.firestore.FieldValue.serverTimestamp;
  const add = (path, data) => docs.push({ path, data: { ...data, stagingData: PROVENANCE } });
  const roleGrants = (...roles) => [...new Set(["dashboard.read", ...roles.flatMap((role) => modules.modules.procurement.roles[role].permissions)])];
  const grants = {
    admin: ["dashboard.read", "propertysettings.read", "users.read", "users.create", "users.update", "users.delete",
      ...modules.modules.procurement.features.flatMap((feature) => catalog[feature].map((action) => `${feature}.${action}`))],
    purchaser: roleGrants("buyer", "purchase-requester", "receiver"),
    approver: roleGrants("approver", "purchase-approver", "purchase-recovery-manager", "order-delivery-recovery-manager", "budget-manager"),
    counter: roleGrants("stock-controller"), revoked: [],
  };
  for (const hotelUid of HOTEL_IDS) {
    const people = users.filter((user) => user.hotelUid === hotelUid), actorUid = userId(hotelUid, "purchaser"), approverUid = userId(hotelUid, "approver");
    const approver = people.find((user) => user.uid === approverUid);
    add(`hotels/${hotelUid}`, { hotelName: `STAGING · Fictional Hotel ${hotelUid.endsWith("a") ? "A" : "B"}`, name: `STAGING · Fictional Hotel ${hotelUid.endsWith("a") ? "A" : "B"}`,
      timeZone: "Europe/Brussels", currency: "EUR", country: "Belgium", createdAt: stamp() });
    add(`hotelSubscriptions/${hotelUid}`, { status: "active", planId: "staging", billingMode: "manual", validUntil: null,
      modules: ["procurement"], modulePolicyVersion: 1, seatLimit: 20, revision: 1, updatedBy: "staging-seed", updatedAt: stamp() });
    add(`hotels/${hotelUid}/settings/bootstrap`, { currency: "EUR" });
    for (const user of people) {
      add(`users/${user.uid}`, { email: user.email, displayName: user.displayName, name: user.displayName, hotelUid: user.role === "revoked" ? [] : [hotelUid], accessRevision: 1 });
      if (user.role !== "revoked") add(`hotels/${hotelUid}/members/${user.uid}`, { email: user.email, displayName: user.displayName,
        hotelAdmin: user.role === "admin", permissions: grants[user.role], updatedAt: stamp(), updatedBy: "staging-seed" });
    }
    const base = buildDemoData({ actorUid, businessDate, currency: "EUR", approvers: [{ uid: approver.uid, email: approver.email, name: approver.displayName }] });
    const remap = (value) => {
      if (typeof value === "string") return value === TEST_HOTEL_UID ? hotelUid : value.replaceAll(`hotels/${TEST_HOTEL_UID}/`, `hotels/${hotelUid}/`);
      if (Array.isArray(value)) return value.map(remap);
      if (value && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)]));
      return value;
    };
    for (const doc of base.docs) add(doc.path.replace(`hotels/${TEST_HOTEL_UID}/`, `hotels/${hotelUid}/`), remap(doc.data));
    const settings = policy.normalizeSettings({ currency: "EUR", costCentres: [{ id: "kitchen", name: "STAGING Kitchen", approverUids: [approverUid] }],
      budgetCategories: [{ id: "maintenance", name: "STAGING Maintenance" }], approvalSteps: [{ id: "manager", name: "Department manager", thresholdMinor: 0 }],
      approvers: [{ uid: approverUid, stepIds: ["manager"], limitMinor: 1000000, canApproveOverBudget: false }], overBudgetMode: "block" });
    add(`hotels/${hotelUid}/settings/purchaseRequests`, { ...settings, policyVersion: 1, revision: 1, ledgerRevision: 1,
      usedCategoryIds: ["maintenance"], usedCostCentreIds: ["kitchen"], currencyLocked: true, updatedAt: stamp() });
    const bucketId = policy.bucketId(month, "maintenance");
    add(`hotels/${hotelUid}/purchaseBudgets/${bucketId}`, { id: bucketId, policyVersion: 1, month, year: Number(month.slice(0, 4)), categoryId: "maintenance",
      currency: "EUR", budgetMinor: 100000, openingUsedMinor: 10000, pendingMinor: 15000, committedMinor: 0, revision: 1, updatedAt: stamp(), updatedBy: actorUid });
    const requester = people.find((user) => user.uid === actorUid), now = Date.parse(`${businessDate}T12:00:00Z`);
    for (const status of ["draft", "pending"]) {
      const id = `staging-request-${status}`, supplier = { id: "demo-v1-supplier-pantry", name: "DEMO · Pantry Supplies" };
      const snapshot = { id, purchaseRequestId: id, hotelUid, policyVersion: 1, revision: 1, requesterUid: actorUid,
        requesterName: requester.displayName, requesterEmail: requester.email, status, createdAtMillis: now, submittedAtMillis: status === "pending" ? now : null,
        approvedAtMillis: null, approvalSteps: status === "pending" ? [{ id: "manager", name: "Department manager" }] : [], approvalEscalation: null,
        selfApproval: null, approvalRoutePlan: [], approvalRouteFingerprint: null, approvalSettingsRevision: 1,
        currentAssignment: null, approvals: [], currentStepIndex: 0, currentApproverUid: status === "pending" ? approverUid : null,
        currentApproverName: status === "pending" ? approver.displayName : null,
        reservation: status === "pending" ? { state: "pending", bucketId, amountMinor: 15000 } : { state: "none", bucketId: null, amountMinor: 0 },
        supplierId: supplier.id, supplier, suppliers: [supplier], title: `STAGING · ${status} freezer repair`, description: "Fictional repair for acceptance testing",
        motivation: "Synthetic compressor replacement", costCentreId: "kitchen", costCentreName: "STAGING Kitchen", budgetCategoryId: "maintenance",
        budgetCategoryName: "STAGING Maintenance", budgetMonth: month, lines: [{ id: "repair", kind: "free", supplierId: supplier.id, supplier,
          description: "STAGING repair", quantity: 1, unitPrice: 150, unit: "service", priceSource: "quote", priceVersionId: null, lineTotalMinor: 15000 }],
        totalMinor: 15000, currency: "EUR", vatBasis: "net", attachmentIds: [], attachments: [], updatedAtMillis: now, updatedBy: actorUid,
        lastDecisionReason: null, stagingData: PROVENANCE };
      const fingerprint = canonicalDigest(snapshot);
      add(`hotels/${hotelUid}/purchaseRequests/${id}`, { ...snapshot, snapshotFingerprint: fingerprint });
      add(`hotels/${hotelUid}/purchaseRequests/${id}/history/000001`, { policyVersion: 1, revision: 1, event: "staging-fixture", actorUid,
        actorName: requester.displayName, reason: "Synthetic staging fixture", createdAtMillis: now, snapshot, snapshotFingerprint: fingerprint, createdAt: stamp() });
    }
  }
  return { docs, users, businessDate, datasetId: DATASET_ID, hotelIds: HOTEL_IDS, subscriptionScenarioHotel: HOTEL_IDS[1],
    summary: { hotels: 2, users: users.length, members: 8, suppliers: 6, catalogProducts: 24, supplierProducts: 30, outlets: 6, locations: 6, budgets: 2, purchaseRequests: 4, orders: 14, receipts: 8, stockCounts: 6 } };
}
