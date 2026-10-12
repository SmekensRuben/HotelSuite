const { subscriptionIsActive } = require("./subscriptions");
const { modulesAreValid } = require("./modulePolicy");
const { normalizedPermissions, permissionAllows } = require("./authorization");
const { validateMonitor } = require("./importMonitoringPolicy");
const catalog = require("./permissionCatalog.json");

const validPermissions = new Set(Object.entries(catalog).flatMap(([feature, actions]) =>
  [...actions, "*"].map((action) => `${feature}.${action}`.toLowerCase())));
const monitorKeys = ["label", "timeZone", "expectedBy", "graceMinutes", "weekdays", "businessDateOffsetDays", "startsOn", "paused", "enabled", "acceptEmpty"];
function validTimeZone(value) {
  try {
    if (typeof value !== "string" || !value || value.length > 80) return false;
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return true;
  } catch { return false; }
}
function validMemberPermissions(value) {
  return Array.isArray(value) && value.length <= 200
    && value.every((key) => typeof key === "string" && validPermissions.has(key.toLowerCase()));
}

// This dated setup assessment does not grant access or certify imported domain data.
function buildHotelSetupReport(raw, now = Date.now()) {
  const issues = [], eligible = [];
  const profiles = new Map(raw.profiles.map((row) => [row.id, row.data]));
  const members = new Map(raw.members.map((row) => [row.id, row.data]));
  const identities = new Map(raw.identities.map((user) => [user.uid, user]));
  const skipped = new Set(raw.invalidUserIds || []);
  for (const uid of [...new Set([...profiles.keys(), ...members.keys()])].sort()) {
    const profile = profiles.get(uid), member = members.get(uid), user = identities.get(uid);
    // Retained legacy profile links are not employee memberships for platform-only operators.
    if (!member && user?.platformAdmin === true) continue;
    const codes = [];
    if (skipped.has(uid)) codes.push("invalid-user-id");
    else if (!user) codes.push("auth-account-missing");
    if (!profile) codes.push("profile-missing");
    else if (!Array.isArray(profile.hotelUid) || !profile.hotelUid.includes(raw.hotelUid)) codes.push("profile-assignment-mismatch");
    if (!member) codes.push("membership-missing");
    else if (!validMemberPermissions(member.permissions)) codes.push("membership-permissions-invalid");
    if (codes.length) issues.push({ uid, codes });
    else if (!user.disabled && user.emailVerified === true) eligible.push({ ...member, uid });
  }
  const enabledAdmins = eligible.filter((member) => member.hotelAdmin === true);
  const pendingAccounts = raw.members.filter((member) => {
    const user = identities.get(member.id);
    return user && !user.disabled && user.emailVerified !== true;
  }).length;
  const disabledAccounts = raw.members.filter((member) => identities.get(member.id)?.disabled === true).length;
  const checks = [];
  const add = (id, label, status, detail, action = "hotel", required = true) => checks.push({ id, label, status, detail, action, required });
  add("release", "Platform activation", raw.releaseReady ? "ready" : "blocked",
    raw.releaseReady ? "The reviewed SaaS release is enabled." : "Complete the verified project-wide release before onboarding.", "activation");
  const validSubscription = modulesAreValid(raw.subscription) && raw.subscription.billingMode === "manual"
    && (raw.subscription.seatLimit === null || Number.isSafeInteger(raw.subscription.seatLimit) && raw.subscription.seatLimit >= 1 && raw.subscription.seatLimit <= 10000);
  add("subscription", "Subscription and modules", validSubscription && subscriptionIsActive(raw.subscription, now) ? "ready" : "blocked",
    validSubscription ? subscriptionIsActive(raw.subscription, now) ? `Active access to ${raw.subscription.modules.length} module(s).` : "Access is expired, suspended or not active." : "An explicit valid module assignment is required.", "subscription");
  add("integrity", "Account and hotel membership consistency", raw.truncated ? "unknown" : issues.length ? "blocked" : "ready",
    raw.truncated ? "The bounded inspection is incomplete; review the listed records and inspection limits." : issues.length ? `${issues.length} account(s) need review. No records were changed.` : `${raw.members.length} member(s) checked against profiles and current Auth identities.`, "team");
  add("administrators", "Primary and backup administrator", raw.truncated ? "unknown" : enabledAdmins.length >= 2 ? "ready" : "pending",
    `${enabledAdmins.length} consistent, enabled, email-verified administrator(s). Two are recommended for setup.`, "team");
  add("invitations", "Team email verification", raw.truncated ? "unknown" : pendingAccounts ? "pending" : "ready",
    `${pendingAccounts} enabled member(s) still need email verification; ${disabledAccounts} account(s) are disabled. Queued email is not proof of delivery.`, "team");
  const propertyReady = validTimeZone(raw.hotel.timeZone) && /^[A-Z]{3}$/.test(raw.bootstrap?.currency || "");
  add("property", "Property time zone and currency", propertyReady ? "ready" : "pending",
    propertyReady ? `Time zone ${raw.hotel.timeZone}; currency ${raw.bootstrap.currency}.` : "Configure a valid IANA time zone and currency.");

  if (validSubscription && raw.subscription.modules.includes("procurement")) {
    const suppliers = new Set(raw.suppliers.filter((row) => row.data.active !== false).map((row) => row.id));
    const usableProducts = raw.products.filter(({ data }) => data.active !== false && suppliers.has(data.supplierId)
      && typeof data.pricePerPurchaseUnit === "number" && Number.isFinite(data.pricePerPurchaseUnit)
      && data.pricePerPurchaseUnit >= 0 && data.pricePerPurchaseUnit <= 1000000
      && typeof data.currency === "string" && /^[A-Z]{3}$/.test(data.currency)
      && typeof data.purchaseUnit === "string" && data.purchaseUnit.trim());
    const sourceReady = raw.outlets.length && suppliers.size && usableProducts.length && raw.locations.length && raw.stockTemplateLocations > 0;
    add("procurement.sources", "Purchasing and stock-count setup", sourceReady ? "ready" : raw.sourceSampleTruncated ? "unknown" : "pending",
      `${raw.sourceSampleTruncated ? "Bounded sample: at least " : ""}${raw.outlets.length} outlet(s), ${suppliers.size} active supplier(s), ${usableProducts.length} usable supplier product(s), ${raw.locations.length} stock location(s), ${raw.stockTemplateLocations || 0} location(s) with a stock template. Setup records are present; template contents and the full catalog are validated during their workflows.`, "procurement");
    const has = (member, action) => permissionAllows(normalizedPermissions(member.permissions), "orders", action);
    const designated = new Set(raw.approverUids);
    const rolesReady = eligible.some((member) => has(member, "read") && has(member, "create"))
      && eligible.some((member) => has(member, "read") && has(member, "approve") && designated.has(member.uid))
      && eligible.some((member) => has(member, "read") && has(member, "receive"))
      && eligible.some((member) => has(member, "read") && has(member, "finalize"))
      && eligible.some((member) => permissionAllows(normalizedPermissions(member.permissions), "stockcounts", "read")
        && permissionAllows(normalizedPermissions(member.permissions), "stockcounts", "create"));
    add("procurement.roles", "Purchasing, receiving and counting roles", rolesReady ? "ready" : raw.truncated || raw.approversTruncated ? "unknown" : "pending",
      rolesReady ? "Enabled, verified members cover purchasing, outlet approval, receiving, receiving supervision and stock counts." : "Assign operational roles deliberately, including an outlet approver, Receiver and Receiving Supervisor. Hotel administration alone grants no operational role.", "team");
  }

  const policies = new Map(raw.monitors.map((row) => [row.id, row.data]));
  const sources = raw.importTypes.filter((row) => row.data.enabled !== false);
  const configured = sources.filter((source) => {
    const policy = policies.get(source.id);
    if (!policy || typeof source.data.fileType !== "string" || !source.data.fileType || source.data.fileType.length > 128 || policy.fileType !== source.data.fileType) return false;
    try {
      const valid = validateMonitor(Object.fromEntries(monitorKeys.map((key) => [key, policy[key]])));
      return valid.enabled && !valid.paused;
    } catch { return false; }
  }).length;
  add("imports", "Expected import deliveries", raw.importsTruncated ? "unknown" : !sources.length ? "not-applicable" : configured === sources.length ? "ready" : "pending",
    !sources.length ? "No enabled import source. Manual purchasing can be set up without an import." : `${configured}/${sources.length} enabled source(s) have validated active delivery schedules. Inspect import health separately.`, "imports");
  const required = checks.filter((check) => check.required);
  const status = required.some((check) => check.status === "blocked") ? "blocked"
    : required.some((check) => check.status === "unknown") ? "unknown"
      : required.some((check) => check.status === "pending") ? "incomplete" : "ready";
  return { hotelUid: raw.hotelUid, schemaVersion: 1, computedAtMillis: now, status, checks,
    integrity: { issueCount: issues.length, issues: issues.slice(0, 100), issuesTruncated: issues.length > 100,
      inspectedMembers: raw.members.length, inspectedProfiles: raw.profiles.length, inspectionTruncated: raw.truncated },
    limits: { catalogSampleTruncated: raw.sourceSampleTruncated === true, approversTruncated: raw.approversTruncated === true, importsTruncated: raw.importsTruncated === true },
    recentInvitations: raw.invitations };
}
module.exports = { validTimeZone, buildHotelSetupReport };
