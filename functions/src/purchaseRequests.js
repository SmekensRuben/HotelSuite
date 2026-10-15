const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireHotelPermission, normalizedPermissions, permissionAllows } = require("./authorization");
const { requireDocumentId } = require("./subscriptions");
const { digest, text, revision, requireCurrentVerifiedUser } = require("./validation");
const { gated, requireSaasRollout } = require("./saasRollout");
const policy = require("./purchaseRequestPolicy");
const products = require("./productPolicy");
const { loadSupplierPriceVersions, resolveSupplierPriceVersion } = require("./supplierPriceVersions");
const { localDate } = require("./importMonitoringPolicy");

const stamp = () => admin.firestore.FieldValue.serverTimestamp();
const settingsPath = (hotelUid) => `hotels/${hotelUid}/settings/purchaseRequests`;
const requestPath = (hotelUid, id) => `hotels/${hotelUid}/purchaseRequests/${id}`;
const budgetPath = (hotelUid, id) => `hotels/${hotelUid}/purchaseBudgets/${id}`;
const noReservation = () => ({ state: "none", bucketId: null, amountMinor: 0 });
const settingsValues = (settings) => Object.fromEntries(policy.SETTINGS_FIELDS.map((key) => [key, settings[key]]));
const REQUEST_ACTIONS = { create: "create", save: "update", revise: "update", submit: "submit", approve: "approve", reject: "approve", return: "approve", withdraw: "cancel", cancel: "cancel" };
function canonicalDigest(value) {
  const canonical = (item) => Array.isArray(item) ? item.map(canonical) : item && typeof item === "object"
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])])) : item;
  return digest(canonical(value));
}
function storedSettings(snapshot) {
  if (!snapshot.exists) return { ...structuredClone(policy.DEFAULT_SETTINGS), revision: 0, ledgerRevision: 0, usedCategoryIds: [], usedCostCentreIds: [], currencyLocked: false, policyVersion: policy.VERSION };
  const value = snapshot.data();
  try {
    if (value.policyVersion !== policy.VERSION || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Number.isSafeInteger(value.ledgerRevision) || value.ledgerRevision < 0
      || !Array.isArray(value.usedCategoryIds) || !Array.isArray(value.usedCostCentreIds) || typeof value.currencyLocked !== "boolean") throw new Error("invalid settings evidence");
    return { ...value, ...policy.normalizeSettings(settingsValues(value)) };
  } catch { throw new HttpsError("failed-precondition", "Purchase request settings need reconciliation."); }
}
async function authorize(db, request, hotelUid, feature, action, tx, services = {}) {
  await requireSaasRollout(db, tx);
  await requireHotelPermission(db, request, hotelUid, feature, action, tx, services.auth);
}
async function requestAuthorization(db, request, hotelUid, action, tx, services) {
  await authorize(db, request, hotelUid, "purchaserequests", "read", tx, services);
  if (action !== "read") await authorize(db, request, hotelUid, "purchaserequests", action, tx, services);
}
function publicRequest(data) {
  const { snapshotFingerprint, ...result } = data;
  return result;
}
function storedRequest(snapshot, hotelUid) {
  if (!snapshot.exists) throw new HttpsError("not-found", "This purchase request does not exist in this hotel.");
  const value = snapshot.data();
  if (value.policyVersion !== policy.VERSION || value.hotelUid !== hotelUid || value.id !== snapshot.id || value.purchaseRequestId !== snapshot.id
    || !Number.isSafeInteger(value.revision) || value.revision < 1 || !["draft", "pending", "returned", "approved", "rejected", "withdrawn", "canceled"].includes(value.status)
    || !Array.isArray(value.lines) || value.lines.length > 50 || !Array.isArray(value.approvals) || !Array.isArray(value.approvalSteps)
    || value.snapshotFingerprint !== canonicalDigest(publicRequest(value))) throw new HttpsError("failed-precondition", "The purchase request snapshot needs reconciliation.");
  const amount = policy.total(value.lines);
  if (value.totalMinor !== amount || !policy.CURRENCIES.includes(value.currency)) throw new HttpsError("failed-precondition", "The purchase request total or currency needs reconciliation.");
  const state = value.reservation?.state;
  if (value.status === "approved" && (state !== "committed" || value.reservation.amountMinor !== amount)
    || ["pending", "returned"].includes(value.status) && state !== "pending"
    || !["pending", "returned", "approved"].includes(value.status) && state !== "none") throw new HttpsError("failed-precondition", "The request's budget reservation needs reconciliation.");
  if (["pending", "approved"].includes(value.status) && (value.reservation.amountMinor !== amount || value.reservation.bucketId !== policy.bucketId(value.budgetMonth, value.budgetCategoryId))) throw new HttpsError("failed-precondition", "The submitted request and its budget reservation do not match.");
  if (value.status === "pending" && (!Number.isSafeInteger(value.currentStepIndex) || value.currentStepIndex < 0 || !value.approvalSteps[value.currentStepIndex]
    || !value.currentApproverUid || value.currentApproverUid === value.requesterUid || value.approvals.length !== value.currentStepIndex)) throw new HttpsError("failed-precondition", "The request's approval chain needs reconciliation.");
  return publicRequest(value);
}
async function memberChoices(tx, db, hotelUid) {
  const members = await tx.get(db.collection(`hotels/${hotelUid}/members`).limit(501));
  if (members.docs.length > 500) throw new HttpsError("failed-precondition", "This hotel exceeds the supported 500-member approval picker. A paged member picker is required.");
  return Promise.all(members.docs.map(async (snapshot) => {
    const membership = snapshot.data(), profile = await tx.get(db.doc(`users/${snapshot.id}`)), user = profile.exists ? profile.data() : {};
    const name = String(membership.displayName || membership.name || user.displayName || user.name || membership.email || user.email || snapshot.id).slice(0, 200);
    const permissions = normalizedPermissions(membership.permissions);
    return { uid: snapshot.id, name, displayName: name, email: String(membership.email || user.email || "").slice(0, 254),
      eligible: permissionAllows(permissions, "purchaserequests", "read") && permissionAllows(permissions, "purchaserequests", "approve") };
  }));
}
function publicSettings(settings, members = []) {
  const byUid = new Map(members.map((member) => [member.uid, member]));
  return { settings: settingsValues(settings), revision: settings.revision, settingsRevision: settings.revision, currencyLocked: settings.currencyLocked,
    approvers: settings.approvers.map((authority) => ({ ...authority, ...(byUid.get(authority.uid) || { uid: authority.uid, name: authority.uid, displayName: authority.uid, email: "", eligible: false }) })),
    users: members };
}
async function currentApprover(tx, db, hotelUid, uid, settings, stepId, amount, requesterUid, previous, services) {
  if (uid == null || uid === "") throw new HttpsError("failed-precondition", "Choose the authorized approver for the next required step.");
  uid = requireDocumentId(uid, "Approver user ID");
  if (uid === requesterUid || previous.some((approval) => approval.approverUid === uid)) throw new HttpsError("permission-denied", "Choose an approver other than the requester and the people who already approved this version.");
  const authority = settings.approvers.find((candidate) => candidate.uid === uid);
  if (!policy.authorityAllows(authority, stepId, amount)) throw new HttpsError("permission-denied", "The selected approver lacks the authority or amount limit for this required step.");
  const member = await tx.get(db.doc(`hotels/${hotelUid}/members/${uid}`));
  const permissions = normalizedPermissions(member.exists ? member.data().permissions : []);
  if (!member.exists || !permissionAllows(permissions, "purchaserequests", "read") || !permissionAllows(permissions, "purchaserequests", "approve")) throw new HttpsError("permission-denied", "The selected approver is not currently authorized to read and approve requests in this hotel.");
  let user;
  try { user = await (services.auth || admin.auth()).getUser(uid); } catch { throw new HttpsError("permission-denied", "The selected approver's account is unavailable."); }
  if (!user || user.uid !== undefined && user.uid !== uid || user.disabled || user.emailVerified !== true) throw new HttpsError("permission-denied", "The selected approver needs an active verified account.");
  return { uid, name: String(user.displayName || member.data().displayName || member.data().name || user.email || uid).slice(0, 200), email: String(user.email || "").slice(0, 254) };
}
async function submissionApprovalRoute(tx, db, hotelUid, settings, value, overBudget, services) {
  const accounts = new Map();
  const currentAuthority = (authority) => {
    if (!accounts.has(authority.uid)) accounts.set(authority.uid, (async () => {
      const member = await tx.get(db.doc(`hotels/${hotelUid}/members/${authority.uid}`));
      const permissions = normalizedPermissions(member.exists ? member.data().permissions : []);
      if (!member.exists || !permissionAllows(permissions, "purchaserequests", "read") || !permissionAllows(permissions, "purchaserequests", "approve")) return null;
      let user;
      try { user = await (services.auth || admin.auth()).getUser(authority.uid); }
      catch (error) {
        if (error.code === "auth/user-not-found") return null;
        // An unavailable account lookup cannot prove that another approver is
        // ineligible and must never weaken the normal approval chain.
        throw new HttpsError("unavailable", "Current approval authority could not be verified. Refresh the approval route and try again.");
      }
      if (!user || user.uid !== undefined && user.uid !== authority.uid) throw new HttpsError("unavailable", "Current approval authority could not be verified. Refresh the approval route and try again.");
      if (user.disabled || user.emailVerified !== true) return null;
      return { uid: authority.uid, name: String(user.displayName || member.data().displayName || member.data().name || user.email || authority.uid).slice(0, 200) };
    })());
    return accounts.get(authority.uid);
  };
  const eligibleFor = async (stepId) => (await Promise.all(settings.approvers.filter((authority) => policy.authorityAllows(authority, stepId, value.totalMinor)).map(currentAuthority))).filter(Boolean);
  let steps = policy.requiredSteps(settings, value.totalMinor, overBudget), escalation = null;
  let eligible = await eligibleFor(steps[0].id);
  if (eligible.length === 1 && eligible[0].uid === value.requesterUid) {
    ({ steps, escalation } = policy.escalateFirstStep(settings, steps));
    eligible = await eligibleFor(steps[0].id);
  }
  const approvers = eligible.filter((candidate) => candidate.uid !== value.requesterUid);
  if (!approvers.length) throw new HttpsError(escalation ? "failed-precondition" : "permission-denied", escalation
    ? "The requester-only first step can only escalate to the immediately next configured step. That step needs an independent active, verified approver with permission and a sufficient request limit."
    : "The first required step needs an independent active, verified approver with permission and a sufficient request limit.");
  const fingerprint = canonicalDigest({ settingsRevision: settings.revision, steps, approvers, escalation });
  return { steps, approvers, escalation, error: null, fingerprint };
}
async function previewSubmissionApprovalRoute(tx, db, hotelUid, value, services) {
  try {
    const settings = storedSettings(await tx.get(db.doc(settingsPath(hotelUid))));
    completeDraft(value, settings);
    if (value.currency !== settings.currency) throw new HttpsError("failed-precondition", "The request currency changed. Save the draft in the configured currency before submitting.");
    const after = { state: "pending", bucketId: policy.bucketId(value.budgetMonth, value.budgetCategoryId), amountMinor: value.totalMinor }, budgets = new Map();
    for (const reservation of [value.reservation, after]) {
      if (!reservation?.bucketId || reservation.state === "none" || budgets.has(reservation.bucketId)) continue;
      const separator = reservation.bucketId.indexOf("__");
      budgets.set(reservation.bucketId, await budgetFor(tx, db, hotelUid, reservation.bucketId.slice(0, separator), reservation.bucketId.slice(separator + 2)));
    }
    if (!budgets.get(after.bucketId)?.exists) throw new HttpsError("failed-precondition", "No budget has been configured for this category and month. Ask a budget manager to create it.");
    const projected = policy.transferBudget(budgets, value.reservation, after).get(after.bucketId);
    return await submissionApprovalRoute(tx, db, hotelUid, settings, value, projected.remainingMinor < 0, services);
  } catch (error) {
    return { steps: [], approvers: [], escalation: null, fingerprint: null,
      error: { code: error instanceof HttpsError ? error.code : "unavailable", message: error instanceof HttpsError ? error.message : "The approval route could not be verified. Refresh and try again." } };
  }
}
function operation(db, hotelUid, uid, requestId, kind, payload) {
  requestId = requireDocumentId(requestId, "requestId");
  return { ref: db.doc(`hotels/${hotelUid}/purchaseRequestOperations/p-${digest(uid, requestId).slice(0, 48)}`), fingerprint: canonicalDigest({ kind, payload }), requestId };
}
async function previousOperation(tx, op, uid) {
  const previous = await tx.get(op.ref);
  if (!previous.exists) return null;
  const value = previous.data();
  if (value.actorUid !== uid || value.fingerprint !== op.fingerprint) throw new HttpsError("already-exists", "This request ID was already used for a different purchase request action.");
  if (!value.result || value.resultFingerprint !== canonicalDigest(value.result)) throw new HttpsError("failed-precondition", "The saved operation receipt needs reconciliation.");
  return value.result;
}
function saveOperation(tx, op, uid, result) { tx.create(op.ref, { policyVersion: policy.VERSION, actorUid: uid, fingerprint: op.fingerprint, result, resultFingerprint: canonicalDigest(result), createdAt: stamp() }); }
function guardedCommand(handler, feature, actionFor) {
  return async (request, services = {}) => {
    try { return await handler(request, services); }
    catch (error) {
      if (!(error instanceof HttpsError)) throw error;
      const details = error.details && typeof error.details === "object" ? { ...error.details } : {};
      delete details.purchaseRequestUncommitted;
      let hotelUid, requestId;
      const action = typeof actionFor === "function" ? actionFor(request.data || {}) : actionFor;
      try {
        hotelUid = requireDocumentId(request.data?.hotelUid, "hotelUid");
        requestId = requireDocumentId(request.data?.requestId, "requestId");
        if (!request.auth?.uid || !action) throw new Error("No authorized command identity");
      } catch { throw new HttpsError(error.code, error.message, details); }
      const db = services.firestore || admin.firestore();
      let absent = false;
      try {
        absent = await db.runTransaction(async (tx) => {
          // Fresh request scope rechecks Auth revocation as well as live hotel
          // rights. An error alone cannot prove an earlier attempt did not commit.
          const actor = { ...request };
          if (feature === "purchaserequests") await requestAuthorization(db, actor, hotelUid, action, tx, services);
          else await authorize(db, actor, hotelUid, feature, action, tx, services);
          const receipt = await tx.get(db.doc(`hotels/${hotelUid}/purchaseRequestOperations/p-${digest(actor.auth.uid, requestId).slice(0, 48)}`));
          return !receipt.exists;
        });
      } catch { /* Preserve uncertainty when current authority or receipt state cannot be verified. */ }
      throw new HttpsError(error.code, error.message, { ...details, ...(absent ? { purchaseRequestUncommitted: true } : {}) });
    }
  };
}
async function budgetFor(tx, db, hotelUid, month, categoryId) {
  const id = policy.bucketId(month, categoryId), snapshot = await tx.get(db.doc(budgetPath(hotelUid, id)));
  if (snapshot.exists) {
    const data = snapshot.data();
    if (data.policyVersion !== policy.VERSION || data.month !== month || data.categoryId !== categoryId || !Number.isSafeInteger(data.revision) || data.revision < 1) throw new HttpsError("failed-precondition", "The budget record needs reconciliation.");
  }
  return policy.budgetProjection(snapshot.exists ? snapshot.data() : null, month, categoryId);
}
const lineSupplierId = (line, value) => Object.hasOwn(line, "supplierId") ? line.supplierId : value.supplierId || "";
async function draftSnapshot(tx, db, hotelUid, id, draft, settings, services) {
  const result = { ...draft, currency: settings.currency, vatBasis: "net", supplierId: "", supplier: null, suppliers: [],
    costCentreName: settings.costCentres.find((item) => item.id === draft.costCentreId)?.name || "",
    budgetCategoryName: settings.budgetCategories.find((item) => item.id === draft.budgetCategoryId)?.name || "" };
  const suppliers = new Map();
  const getSupplier = async (supplierId) => {
    if (!supplierId) return null;
    if (!suppliers.has(supplierId)) {
      const snapshot = await tx.get(db.doc(`hotels/${hotelUid}/suppliers/${supplierId}`)), supplier = snapshot.exists ? snapshot.data() : null;
      if (!supplier || supplier.archived || supplier.archivedAt || supplier.active === false) throw new HttpsError("failed-precondition", "Choose an active supplier from this hotel for each purchase line.");
      suppliers.set(supplierId, supplier);
    }
    return suppliers.get(supplierId);
  };
  let today;
  const getDate = async () => {
    if (today) return today;
    const hotel = await tx.get(db.doc(`hotels/${hotelUid}`));
    if (!hotel.exists) throw new HttpsError("failed-precondition", "Hotel configuration is missing.");
    try { today = localDate(services.now?.() ?? Date.now(), hotel.data().timeZone || "UTC"); }
    catch { throw new HttpsError("failed-precondition", "Review the hotel's time zone before estimating supplier prices."); }
    return today;
  };
  result.lines = [];
  const priceVersions = new Map();
  for (const line of draft.lines) {
    const supplierId = lineSupplierId(line, draft), supplier = await getSupplier(supplierId);
    let next = { ...line, supplierId, supplier: supplier ? { id: supplierId, name: String(supplier.name || supplierId).slice(0, 200) } : null, priceSource: "quote", priceVersionId: null };
    if (line.kind === "supplier") {
      if (!supplier) throw new HttpsError("invalid-argument", "Choose a supplier for this purchase line before adding a supplier product.");
      const productSnapshot = await tx.get(db.doc(`hotels/${hotelUid}/supplierproducts/${line.supplierProductId}`));
      const product = productSnapshot.exists ? productSnapshot.data() : null;
      if (!product || product.supplierId !== supplierId || product.active !== true || product.archived || product.archivedAt) throw new HttpsError("failed-precondition", "The selected supplier product must be active and belong to this line's supplier in this hotel.");
      let resolved = product, priceInfo = null;
      if (line.unitPrice === undefined) {
        if (!priceVersions.has(line.supplierProductId)) priceVersions.set(line.supplierProductId, await loadSupplierPriceVersions(tx, db, hotelUid, line.supplierProductId));
        const date = await getDate();
        if (supplier.priceDateBasis === "delivery-date") throw new HttpsError("failed-precondition", "This supplier prices by delivery date. Enter an explicit net quotation for this internal estimate.");
        priceInfo = resolveSupplierPriceVersion(product, priceVersions.get(line.supplierProductId), { orderDate: date, pricingDateBasis: supplier.priceDateBasis });
        resolved = priceInfo.product;
      }
      const optionSource = line.purchaseOptionId === "default" ? resolved : resolved.purchaseOptions?.find((item) => item.id === line.purchaseOptionId);
      if (!optionSource) throw new HttpsError("failed-precondition", "The selected supplier purchase option no longer exists.");
      const option = line.unitPrice === undefined ? products.resolvePurchaseOption(resolved, line.purchaseOptionId) : { purchaseUnit: optionSource.purchaseUnit, baseUnit: resolved.baseUnit,
        baseUnitsPerPurchaseUnit: optionSource.baseUnitsPerPurchaseUnit, currency: settings.currency, netPricePerPurchaseUnit: line.unitPrice };
      if (line.unitPrice === undefined && (option.currency !== settings.currency || option.netPricePerPurchaseUnit == null)) throw new HttpsError("failed-precondition", "This supplier price has an unknown net basis or another currency. Enter an explicit net quotation in the request currency.");
      const unitPrice = policy.decimal(option.netPricePerPurchaseUnit, "Net unit price");
      next = { ...next, description: line.description || String(product.supplierProductName || product.name || line.supplierProductId).slice(0, 500), unit: String(option.purchaseUnit || "purchase unit").slice(0, 100), unitPrice,
        supplierSku: String(product.supplierSku || "").slice(0, 150), supplierProductName: String(product.supplierProductName || product.name || "").slice(0, 200),
        brand: String(product.brand || "").slice(0, 200), catalogProductId: product.catalogProductId || null, baseUnit: option.baseUnit || null,
        baseUnitsPerPurchaseUnit: option.baseUnitsPerPurchaseUnit ?? null, priceSource: line.unitPrice === undefined ? "supplier" : "quote", priceVersionId: priceInfo?.versionId || null,
        priceNeedsReview: priceInfo?.needsReview ?? false, priceReviewReasons: priceInfo?.reasons || [], supplierRevision: Number.isSafeInteger(product.revision) ? product.revision : 0 };
      if (next.catalogProductId) {
        const catalog = await tx.get(db.doc(`hotels/${hotelUid}/catalogproducts/${requireDocumentId(next.catalogProductId, "Catalog product ID")}`));
        if (!catalog.exists) throw new HttpsError("failed-precondition", "This supplier product's catalog reference needs reconciliation.");
        next.catalogProductName = String(catalog.data().name || next.catalogProductId).slice(0, 200);
        next.internalSku = String(catalog.data().internalSku || "").slice(0, 100);
      }
    }
    next.lineTotalMinor = policy.lineTotal(next.quantity, next.unitPrice);
    result.lines.push(next);
  }
  result.suppliers = [...new Map(result.lines.filter((line) => line.supplier).map((line) => [line.supplierId, line.supplier])).values()];
  if (result.lines.length && result.lines.every((line) => line.supplierId && line.supplierId === result.lines[0].supplierId)) {
    result.supplierId = result.lines[0].supplierId; result.supplier = result.lines[0].supplier;
  }
  result.totalMinor = policy.total(result.lines);
  result.attachments = await require("./purchaseRequestFiles").validatePurchaseRequestAttachments(tx, db, hotelUid, id, draft.attachmentIds);
  return result;
}
function completeDraft(value, settings) {
  if (!value.title || !value.motivation || !value.budgetMonth || !settings.costCentres.some((row) => row.id === value.costCentreId)
    || !settings.budgetCategories.some((row) => row.id === value.budgetCategoryId) || !value.lines.length || value.lines.some((line) => !line.description || !line.unit || !lineSupplierId(line, value))) throw new HttpsError("failed-precondition", "Complete the title, motivation, cost centre, budget category, budget month and purchase lines, including a supplier for every line, before submitting.");
}
function draftInputFromSnapshot(value) {
  return Object.fromEntries(["supplierId", "title", "description", "motivation", "costCentreId", "budgetCategoryId", "budgetMonth", "attachmentIds"].map((key) => [key, value[key]]).concat([["lines", value.lines.map((line) => {
    const fields = ["id", "kind", "description", "quantity", "unitPrice", "unit", ...(Object.hasOwn(line, "supplierId") ? ["supplierId"] : []), ...(line.kind === "supplier" ? ["supplierProductId", "purchaseOptionId"] : [])];
    return Object.fromEntries(fields.map((key) => [key, line[key]]));
  })]]));
}

async function getHotelPurchaseRequestSettingsHandler(request, services = {}) {
  const input = request.data || {}; policy.exact(input, ["hotelUid"], "settings read");
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), db = services.firestore || admin.firestore();
  return db.runTransaction(async (tx) => {
    await authorize(db, request, hotelUid, "purchasebudgets", "settings", tx, services);
    const settings = storedSettings(await tx.get(db.doc(settingsPath(hotelUid))));
    return { hotelUid, ...publicSettings(settings, await memberChoices(tx, db, hotelUid)) };
  });
}
async function saveHotelPurchaseRequestSettingsHandler(request, services = {}) {
  const input = request.data || {}; policy.exact(input, ["hotelUid", "requestId", "expectedRevision", "settings"], "settings update");
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), settings = policy.normalizeSettings(input.settings), expected = revision(input.expectedRevision), db = services.firestore || admin.firestore();
  const op = operation(db, hotelUid, request.auth?.uid, input.requestId, "settings", { expected, settings });
  return db.runTransaction(async (tx) => {
    await authorize(db, request, hotelUid, "purchasebudgets", "settings", tx, services);
    const previous = await previousOperation(tx, op, request.auth.uid); if (previous) return previous;
    const ref = db.doc(settingsPath(hotelUid)), before = storedSettings(await tx.get(ref));
    if (before.revision !== expected) throw new HttpsError("aborted", "Purchase request settings changed. Reload before saving.");
    if (before.currencyLocked && before.currency !== settings.currency) throw new HttpsError("failed-precondition", "The request currency cannot change after budgets or reservations have been recorded.");
    if (before.usedCategoryIds.some((id) => !settings.budgetCategories.some((row) => row.id === id)) || before.usedCostCentreIds.some((id) => !settings.costCentres.some((row) => row.id === id))) throw new HttpsError("failed-precondition", "Keep the stable IDs of budget categories and cost centres already used by requests or budgets.");
    for (const authority of settings.approvers) {
      const first = authority.stepIds[0] || (authority.canApproveOverBudget ? "over-budget" : null);
      if (!first) throw new HttpsError("invalid-argument", "An approver needs at least one standard step or additional budget authority.");
      await currentApprover(tx, db, hotelUid, authority.uid, settings, first, 0, "", [], services);
    }
    const next = { ...before, ...settings, revision: before.revision + 1, updatedAt: stamp(), updatedBy: request.auth.uid };
    const result = { hotelUid, requestId: op.requestId, ...publicSettings(next, await memberChoices(tx, db, hotelUid)) };
    tx.set(ref, next); saveOperation(tx, op, request.auth.uid, result); return result;
  });
}
async function getHotelPurchaseBudgetsHandler(request, services = {}) {
  const input = request.data || {}; policy.exact(input, ["hotelUid", "year"], "budget read");
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), year = input.year;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new HttpsError("invalid-argument", "Choose a budget year from 2000 to 2100.");
  const db = services.firestore || admin.firestore();
  return db.runTransaction(async (tx) => {
    await authorize(db, request, hotelUid, "purchasebudgets", "read", tx, services);
    const settings = storedSettings(await tx.get(db.doc(settingsPath(hotelUid))));
    const snapshots = await tx.get(db.collection(`hotels/${hotelUid}/purchaseBudgets`).where("year", "==", year).limit(1201));
    if (snapshots.docs.length > 1200) throw new HttpsError("failed-precondition", "Budget records exceed the configured yearly category limit.");
    return { hotelUid, year, currency: settings.currency, vatBasis: "net", budgetCategories: settings.budgetCategories, costCentres: settings.costCentres,
      budgets: snapshots.docs.map((snapshot) => policy.budgetProjection(snapshot.data(), snapshot.data().month, snapshot.data().categoryId)) };
  });
}
async function saveHotelPurchaseBudgetsHandler(request, services = {}) {
  const input = request.data || {}; policy.exact(input, ["hotelUid", "requestId", "budgets"], "budget update");
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), db = services.firestore || admin.firestore();
  if (!Array.isArray(input.budgets) || !input.budgets.length || input.budgets.length > 240) throw new HttpsError("invalid-argument", "Save between one and 240 monthly budgets together.");
  const rows = input.budgets.map((row) => { policy.exact(row, ["month", "categoryId", "budgetMinor", "openingUsedMinor", "expectedRevision"], "monthly budget");
    return { month: policy.month(row.month), categoryId: policy.id(row.categoryId), budgetMinor: policy.money(row.budgetMinor, "Budget"), openingUsedMinor: policy.money(row.openingUsedMinor, "Opening used amount"), expectedRevision: revision(row.expectedRevision) }; });
  if (new Set(rows.map((row) => policy.bucketId(row.month, row.categoryId))).size !== rows.length) throw new HttpsError("invalid-argument", "Monthly budget categories must not be repeated.");
  const op = operation(db, hotelUid, request.auth?.uid, input.requestId, "budgets", rows);
  return db.runTransaction(async (tx) => {
    await authorize(db, request, hotelUid, "purchasebudgets", "update", tx, services);
    const previous = await previousOperation(tx, op, request.auth.uid); if (previous) return previous;
    const settingsRef = db.doc(settingsPath(hotelUid)), settings = storedSettings(await tx.get(settingsRef));
    if (settings.revision === 0) throw new HttpsError("failed-precondition", "Save purchase request settings before creating budgets.");
    const budgets = [];
    for (const row of rows) {
      if (!settings.budgetCategories.some((category) => category.id === row.categoryId)) throw new HttpsError("invalid-argument", "Choose a configured budget category.");
      const before = await budgetFor(tx, db, hotelUid, row.month, row.categoryId);
      if (before.revision !== row.expectedRevision) throw new HttpsError("aborted", "A monthly budget changed. Reload before saving the year.");
      const next = policy.budgetProjection({ ...before, budgetMinor: row.budgetMinor, openingUsedMinor: row.openingUsedMinor, revision: before.revision + 1 }, row.month, row.categoryId);
      if (settings.overBudgetMode === "block" && next.remainingMinor < 0) throw new HttpsError("failed-precondition", "This budget would be lower than its recorded usage and reservations.");
      budgets.push(next);
    }
    const result = { hotelUid, requestId: op.requestId, currency: settings.currency, vatBasis: "net", budgets };
    for (const value of budgets) tx.set(db.doc(budgetPath(hotelUid, value.id)), { ...value, year: Number(value.month.slice(0, 4)), policyVersion: policy.VERSION, currency: settings.currency, updatedAt: stamp(), updatedBy: request.auth.uid });
    tx.set(settingsRef, { ...settings, currencyLocked: true, ledgerRevision: settings.ledgerRevision + 1,
      usedCategoryIds: [...new Set([...settings.usedCategoryIds, ...rows.map((row) => row.categoryId)])], updatedAt: stamp() });
    saveOperation(tx, op, request.auth.uid, result); return result;
  });
}

async function getHotelPurchaseRequestContextHandler(request, services = {}) {
  const input = request.data || {}; policy.exact(input, ["hotelUid", "supplierId", "query", "cursor", "budgetMonth", "budgetCategoryId"], "request context");
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), supplierId = input.supplierId ? requireDocumentId(input.supplierId, "supplierId") : null;
  const cursor = input.cursor ? requireDocumentId(input.cursor, "cursor") : null, search = text(input.query ?? "", "Product search", 100).toLowerCase();
  const db = services.firestore || admin.firestore();
  return db.runTransaction(async (tx) => {
    await requestAuthorization(db, request, hotelUid, "read", tx, services);
    const settings = storedSettings(await tx.get(db.doc(settingsPath(hotelUid))));
    const members = await memberChoices(tx, db, hotelUid);
    const supplierDocs = await tx.get(db.collection(`hotels/${hotelUid}/suppliers`).limit(501));
    if (supplierDocs.docs.length > 500) throw new HttpsError("failed-precondition", "This hotel requires a paged supplier picker before using purchase requests.");
    const suppliers = supplierDocs.docs.filter((snapshot) => !snapshot.data().archived && !snapshot.data().archivedAt && snapshot.data().active !== false)
      .map((snapshot) => ({ id: snapshot.id, name: String(snapshot.data().name || snapshot.id).slice(0, 200) }));
    let budget = null;
    if (input.budgetMonth || input.budgetCategoryId) {
      if (!input.budgetMonth || !input.budgetCategoryId) throw new HttpsError("invalid-argument", "A budget preview needs both month and category.");
      const categoryId = policy.id(input.budgetCategoryId), month = policy.month(input.budgetMonth);
      if (!settings.budgetCategories.some((row) => row.id === categoryId)) throw new HttpsError("invalid-argument", "Choose a configured budget category.");
      budget = await budgetFor(tx, db, hotelUid, month, categoryId);
    }
    let supplierProducts = [], nextProductCursor = null;
    if (supplierId) {
      if (!suppliers.some((supplier) => supplier.id === supplierId)) throw new HttpsError("invalid-argument", "Choose an active supplier in this hotel.");
      let query = db.collection(`hotels/${hotelUid}/supplierproducts`).where("supplierId", "==", supplierId).orderBy(admin.firestore.FieldPath.documentId());
      if (cursor) query = query.startAfter(cursor);
      const source = await tx.get(query.limit(201)), scanned = source.docs.slice(0, 200);
      const supplier = supplierDocs.docs.find((snapshot) => snapshot.id === supplierId).data();
      const hotel = await tx.get(db.doc(`hotels/${hotelUid}`));
      if (!hotel.exists) throw new HttpsError("failed-precondition", "Hotel configuration is missing.");
      let today;
      try { today = localDate(services.now?.() ?? Date.now(), hotel.data().timeZone || "UTC"); }
      catch { throw new HttpsError("failed-precondition", "Review the hotel's time zone before estimating supplier prices."); }
      let last = null;
      for (const snapshot of scanned) {
        last = snapshot.id; const product = snapshot.data();
        if (!product.active || product.archived || product.archivedAt || search && !`${product.supplierProductName || ""} ${product.supplierSku || ""} ${product.brand || ""}`.toLowerCase().includes(search)) continue;
        let selected = product, priceInfo = null;
        if (supplier.priceDateBasis !== "delivery-date") {
          priceInfo = resolveSupplierPriceVersion(product, await loadSupplierPriceVersions(tx, db, hotelUid, snapshot.id), { orderDate: today, pricingDateBasis: supplier.priceDateBasis });
          selected = priceInfo.product;
        }
        const requiresQuote = supplier.priceDateBasis === "delivery-date" || selected.currency !== settings.currency;
        const netPrice = (price) => requiresQuote ? null : products.netPrice(price, selected.priceBasis, selected.vatRate);
        supplierProducts.push({ id: snapshot.id, supplierProductName: String(product.supplierProductName || product.name || snapshot.id).slice(0, 200), supplierSku: String(product.supplierSku || "").slice(0, 150), brand: String(product.brand || "").slice(0, 200),
          currency: selected.currency || null, purchaseUnit: selected.purchaseUnit || null, pricePerPurchaseUnit: netPrice(selected.pricePerPurchaseUnit),
          baseUnit: selected.baseUnit || null, baseUnitsPerPurchaseUnit: selected.baseUnitsPerPurchaseUnit ?? null,
          priceValidity: priceInfo?.priceValidity || "delivery-date-required", priceVersionId: priceInfo?.versionId || null,
          priceNeedsReview: requiresQuote || priceInfo?.needsReview === true, priceReviewReasons: priceInfo?.reasons || ["delivery-date-required"],
          requiresQuote: requiresQuote || netPrice(selected.pricePerPurchaseUnit) === null,
          purchaseOptions: (Array.isArray(selected.purchaseOptions) ? selected.purchaseOptions : []).slice(0, 20).map((option) => ({ id: option.id, purchaseUnit: option.purchaseUnit,
            baseUnitsPerPurchaseUnit: option.baseUnitsPerPurchaseUnit ?? null, pricePerPurchaseUnit: netPrice(option.pricePerPurchaseUnit) })) });
        if (supplierProducts.length === 50) break;
      }
      if (last && (source.docs.length > scanned.length || scanned.at(-1)?.id !== last)) nextProductCursor = last;
    }
    return { hotelUid, ...publicSettings(settings, members), suppliers, supplierProducts, nextProductCursor, budget, vatBasis: "net" };
  });
}
async function listHotelPurchaseRequestsHandler(request, services = {}) {
  const input = request.data || {}; policy.exact(input, ["hotelUid", "status", "month", "costCentreId", "awaitingMyApproval", "cursor", "limit"], "request list");
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), db = services.firestore || admin.firestore(), limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || input.awaitingMyApproval !== undefined && typeof input.awaitingMyApproval !== "boolean") throw new HttpsError("invalid-argument", "Choose a page of one to 100 requests and a valid approval filter.");
  if (input.status && !["draft", "pending", "returned", "approved", "rejected", "withdrawn", "canceled"].includes(input.status)) throw new HttpsError("invalid-argument", "Choose a supported request status.");
  return db.runTransaction(async (tx) => {
    await requestAuthorization(db, request, hotelUid, "read", tx, services);
    let query = db.collection(`hotels/${hotelUid}/purchaseRequests`);
    if (input.status) query = query.where("status", "==", input.status);
    if (input.month) query = query.where("budgetMonth", "==", policy.month(input.month));
    if (input.costCentreId) query = query.where("costCentreId", "==", policy.id(input.costCentreId));
    if (input.awaitingMyApproval) query = query.where("currentApproverUid", "==", request.auth.uid).where("status", "==", "pending");
    query = query.orderBy(admin.firestore.FieldPath.documentId());
    if (input.cursor) query = query.startAfter(requireDocumentId(input.cursor, "cursor"));
    const found = await tx.get(query.limit(limit + 1)), page = found.docs.slice(0, limit);
    return { hotelUid, requests: page.map((snapshot) => storedRequest(snapshot, hotelUid)), nextCursor: found.docs.length > limit ? page.at(-1).id : null };
  });
}
async function getHotelPurchaseRequestHandler(request, services = {}) {
  const input = request.data || {}; policy.exact(input, ["hotelUid", "purchaseRequestId", "historyBeforeRevision"], "request read");
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), id = requireDocumentId(input.purchaseRequestId, "purchaseRequestId"), db = services.firestore || admin.firestore();
  if (input.historyBeforeRevision !== undefined && (!Number.isSafeInteger(input.historyBeforeRevision) || input.historyBeforeRevision < 1 || input.historyBeforeRevision > 10001)) throw new HttpsError("invalid-argument", "Choose a valid earlier history revision.");
  return db.runTransaction(async (tx) => {
    await requestAuthorization(db, request, hotelUid, "read", tx, services);
    const value = storedRequest(await tx.get(db.doc(requestPath(hotelUid, id))), hotelUid);
    let historyQuery = db.collection(`${requestPath(hotelUid, id)}/history`);
    if (input.historyBeforeRevision !== undefined) historyQuery = historyQuery.where("revision", "<", input.historyBeforeRevision);
    const found = await tx.get(historyQuery.orderBy("revision", "desc").limit(101));
    const history = found.docs.slice(0, 100).map((snapshot) => {
      const event = snapshot.data();
      if (!event.snapshot || event.snapshotFingerprint !== canonicalDigest(event.snapshot) || event.snapshot.hotelUid !== hotelUid || event.snapshot.id !== id
        || !Number.isSafeInteger(event.revision) || event.revision < 1 || event.snapshot.revision !== event.revision || snapshot.id !== String(event.revision).padStart(6, "0")) throw new HttpsError("failed-precondition", "The immutable request history needs reconciliation.");
      return event;
    });
    const budget = value.budgetMonth && value.budgetCategoryId ? await budgetFor(tx, db, hotelUid, value.budgetMonth, value.budgetCategoryId) : null;
    const route = value.requesterUid === request.auth.uid && ["draft", "returned"].includes(value.status) ? await previewSubmissionApprovalRoute(tx, db, hotelUid, value, services) : null;
    return { hotelUid, request: value, history, historyTruncated: found.docs.length > 100, nextHistoryCursor: found.docs.length > 100 ? history.at(-1).revision : null, budget, submissionApprovalRoute: route };
  });
}

async function mutateHotelPurchaseRequestHandler(request, services = {}) {
  const input = request.data || {}; policy.exact(input, ["hotelUid", "requestId", "purchaseRequestId", "expectedRevision", "action", "draft", "approverUid", "nextApproverUid", "reason", "expectedApprovalRouteFingerprint"], "request mutation");
  const actions = REQUEST_ACTIONS;
  if (!Object.hasOwn(actions, input.action)) throw new HttpsError("invalid-argument", "Choose a supported purchase request action.");
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), expected = revision(input.expectedRevision), action = input.action, db = services.firestore || admin.firestore();
  const id = action === "create" ? `p-${digest(request.auth?.uid, requireDocumentId(input.requestId, "requestId")).slice(0, 40)}` : requireDocumentId(input.purchaseRequestId, "purchaseRequestId");
  if (action === "create" && input.purchaseRequestId != null) throw new HttpsError("invalid-argument", "The server assigns the identity of a new request.");
  const draft = input.draft === undefined ? null : policy.normalizeDraft(input.draft), reason = text(input.reason ?? "", "Decision reason", 2000, ["reject", "return", "revise"].includes(action));
  if (["create", "save"].includes(action) && !draft || !["create", "save", "revise"].includes(action) && draft) throw new HttpsError("invalid-argument", "Only draft creation, saving or an explicit revision may change request content.");
  if (input.approverUid != null && action !== "submit" || input.nextApproverUid != null && action !== "approve") throw new HttpsError("invalid-argument", "Approver selection must belong to its submission or decision.");
  if (input.expectedApprovalRouteFingerprint !== undefined && (action !== "submit" || typeof input.expectedApprovalRouteFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedApprovalRouteFingerprint))) throw new HttpsError("invalid-argument", "A submission approval route fingerprint must come from the current request preview.");
  const op = operation(db, hotelUid, request.auth?.uid, input.requestId, "request", { id, action, expected, draft, approverUid: input.approverUid ?? null, nextApproverUid: input.nextApproverUid ?? null, reason,
    ...(input.expectedApprovalRouteFingerprint === undefined ? {} : { expectedApprovalRouteFingerprint: input.expectedApprovalRouteFingerprint }) });
  return db.runTransaction(async (tx) => {
    await requestAuthorization(db, request, hotelUid, actions[action], tx, services);
    const previous = await previousOperation(tx, op, request.auth.uid); if (previous) return previous;
    const settingsRef = db.doc(settingsPath(hotelUid)), settings = storedSettings(await tx.get(settingsRef)), ref = db.doc(requestPath(hotelUid, id)), snapshot = await tx.get(ref);
    if (action === "create" && snapshot.exists) throw new HttpsError("already-exists", "This purchase request already exists. Recover the original creation receipt.");
    const before = snapshot.exists ? storedRequest(snapshot, hotelUid) : null;
    if (action !== "create" && !before) throw new HttpsError("not-found", "This purchase request does not exist in this hotel.");
    if ((before?.revision ?? 0) !== expected) throw new HttpsError("aborted", "This purchase request changed. Reload before continuing.");
    if (before) {
      const certificate = await tx.get(db.doc(`${ref.path}/history/${String(before.revision).padStart(6, "0")}`));
      const evidence = certificate.exists ? certificate.data() : null, fingerprint = canonicalDigest(before);
      if (!evidence || evidence.policyVersion !== policy.VERSION || evidence.revision !== before.revision || evidence.snapshot?.hotelUid !== hotelUid || evidence.snapshot?.id !== id
        || evidence.snapshot?.revision !== before.revision || evidence.snapshotFingerprint !== fingerprint || canonicalDigest(evidence.snapshot) !== fingerprint) throw new HttpsError("failed-precondition", "The latest immutable request history is missing or inconsistent. Reconcile the restored evidence before changing this request.");
    }
    if (before?.revision >= 10000) throw new HttpsError("resource-exhausted", "This request has reached its supported history limit.");
    const actorUser = await requireCurrentVerifiedUser(request, services.auth), actor = { uid: request.auth.uid, name: String(actorUser.displayName || actorUser.email || request.auth.uid).slice(0, 200), email: String(actorUser.email || "").slice(0, 254) };
    if (before && ["save", "revise", "submit", "withdraw", "cancel"].includes(action) && before.requesterUid !== actor.uid) throw new HttpsError("permission-denied", "Only the requester may change, submit, withdraw or cancel this request.");
    const now = services.now?.() ?? Date.now();
    let next = before ? { ...before } : { id, purchaseRequestId: id, hotelUid, policyVersion: policy.VERSION, revision: 0, requesterUid: actor.uid,
      requesterName: actor.name, requesterEmail: actor.email, status: "draft", createdAtMillis: now, submittedAtMillis: null, approvedAtMillis: null,
      approvalSteps: [], approvalEscalation: null, approvals: [], currentStepIndex: 0, currentApproverUid: null, currentApproverName: null, reservation: noReservation() };
    if (action === "create" || action === "save") {
      if (before && !["draft", "returned"].includes(before.status)) throw new HttpsError("failed-precondition", "Only a draft or returned request may be edited. Start an explicit revision for a submitted request.");
      next = { ...next, ...await draftSnapshot(tx, db, hotelUid, id, draft, settings, services), approvalEscalation: null };
    }
    if (action === "revise") {
      if (!["pending", "approved"].includes(before.status)) throw new HttpsError("failed-precondition", "Only a pending or approved request needs a new approval revision.");
      next = { ...next, ...(draft ? await draftSnapshot(tx, db, hotelUid, id, draft, settings, services) : {}), status: "returned", approvalEscalation: null, approvals: [], currentStepIndex: 0,
        currentApproverUid: null, currentApproverName: null, approvedAtMillis: null, reservation: { ...before.reservation, state: "pending" } };
    }
    if (action === "submit") {
      if (!["draft", "returned"].includes(before.status)) throw new HttpsError("failed-precondition", "Only a draft or returned request may be submitted.");
      completeDraft(before, settings);
      // Keep saved, explicitly reviewed price and identity snapshots; source
      // catalog updates never silently replace an internal estimate on submit.
      next.attachments = await require("./purchaseRequestFiles").validatePurchaseRequestAttachments(tx, db, hotelUid, id, before.attachmentIds);
      if (before.currency !== settings.currency) throw new HttpsError("failed-precondition", "The request currency changed. Save the draft in the configured currency before submitting.");
      next.reservation = { state: "pending", bucketId: policy.bucketId(before.budgetMonth, before.budgetCategoryId), amountMinor: before.totalMinor };
      next.status = "pending"; next.approvals = []; next.currentStepIndex = 0; next.submittedAtMillis = now; next.approvedAtMillis = null;
    }
    if (["approve", "reject", "return"].includes(action)) {
      if (before.status !== "pending" || before.currentApproverUid !== actor.uid) throw new HttpsError("permission-denied", "Only the current assigned approver may decide this pending step.");
      await currentApprover(tx, db, hotelUid, actor.uid, settings, before.approvalSteps[before.currentStepIndex]?.id, before.totalMinor, before.requesterUid, before.approvals, services);
      if (action === "reject") { next.status = "rejected"; next.reservation = noReservation(); next.currentApproverUid = null; next.currentApproverName = null; }
      if (action === "return") { next.status = "returned"; next.approvalEscalation = null; next.approvals = []; next.currentStepIndex = 0; next.currentApproverUid = null; next.currentApproverName = null; }
    }
    if (["withdraw", "cancel"].includes(action)) {
      const allowed = action === "withdraw" ? ["pending", "returned"] : ["draft", "pending", "returned", "approved"];
      if (!allowed.includes(before.status)) throw new HttpsError("failed-precondition", "This request cannot be withdrawn or canceled in its current status.");
      next.status = action === "withdraw" ? "withdrawn" : "canceled"; next.reservation = noReservation(); next.currentApproverUid = null; next.currentApproverName = null;
    }
    const budgets = new Map();
    for (const reservation of [before?.reservation, next.reservation]) {
      if (reservation?.state === "none" || !reservation?.bucketId || budgets.has(reservation.bucketId)) continue;
      const separator = reservation.bucketId.indexOf("__"), budgetMonth = reservation.bucketId.slice(0, separator), categoryId = reservation.bucketId.slice(separator + 2);
      budgets.set(reservation.bucketId, await budgetFor(tx, db, hotelUid, budgetMonth, categoryId));
    }
    let changedBudgets = policy.transferBudget(budgets, before?.reservation, next.reservation), currentBudget = next.reservation.state === "none" ? null : changedBudgets.get(next.reservation.bucketId);
    if (action === "submit") {
      if (!currentBudget?.exists) throw new HttpsError("failed-precondition", "No budget has been configured for this category and month. Ask a budget manager to create it.");
      const route = await submissionApprovalRoute(tx, db, hotelUid, settings, next, currentBudget.remainingMinor < 0, services);
      if (input.expectedApprovalRouteFingerprint !== undefined && input.expectedApprovalRouteFingerprint !== route.fingerprint) throw new HttpsError("aborted", "The submission approval route changed. Refresh the request and review the current route before submitting.");
      next.approvalSteps = route.steps; next.approvalEscalation = route.escalation;
      const assignee = await currentApprover(tx, db, hotelUid, input.approverUid, settings, next.approvalSteps[0].id, next.totalMinor, next.requesterUid, [], services);
      next.currentApproverUid = assignee.uid; next.currentApproverName = assignee.name;
    }
    let event = action;
    if (action === "approve") {
      if (!currentBudget?.exists) throw new HttpsError("failed-precondition", "The reserved budget is missing.");
      if (currentBudget.remainingMinor < 0) {
        if (settings.overBudgetMode === "block") throw new HttpsError("failed-precondition", "The available budget changed and is exceeded. A budget manager must resolve it before approval.");
        if (!next.approvalSteps.some((step) => step.id === "over-budget")) next.approvalSteps = [...next.approvalSteps, { id: "over-budget", name: "Additional budget approval" }];
      }
      next.approvals = [...before.approvals, { stepId: before.approvalSteps[before.currentStepIndex].id, approverUid: actor.uid, approverName: actor.name, approvedAtMillis: now }];
      next.currentStepIndex = before.currentStepIndex + 1;
      if (next.currentStepIndex < next.approvalSteps.length) {
        const assignee = await currentApprover(tx, db, hotelUid, input.nextApproverUid, settings, next.approvalSteps[next.currentStepIndex].id, next.totalMinor, next.requesterUid, next.approvals, services);
        next.currentApproverUid = assignee.uid; next.currentApproverName = assignee.name;
      } else {
        if (input.nextApproverUid != null && input.nextApproverUid !== "") throw new HttpsError("invalid-argument", "A completed approval has no next approver.");
        next.status = "approved"; next.currentApproverUid = null; next.currentApproverName = null; next.approvedAtMillis = now;
        next.reservation = { ...next.reservation, state: "committed" }; event = "approved";
        changedBudgets = policy.transferBudget(budgets, before.reservation, next.reservation); currentBudget = changedBudgets.get(next.reservation.bucketId);
      }
    }
    next = { ...next, revision: (before?.revision ?? 0) + 1, updatedAtMillis: now, updatedBy: actor.uid, lastDecisionReason: reason || null };
    const writes = [];
    for (const [key, value] of changedBudgets) {
      const original = budgets.get(key);
      if (value.pendingMinor !== original.pendingMinor || value.committedMinor !== original.committedMinor) {
        const written = { ...value, revision: original.revision + 1 };
        writes.push(written); if (currentBudget?.id === key) currentBudget = written;
      }
    }
    const reservationChanged = digest(before?.reservation || noReservation()) !== digest(next.reservation);
    const result = { hotelUid, requestId: op.requestId, purchaseRequestId: id, revision: next.revision, request: next, budget: currentBudget };
    // Notification creation is part of the same transaction as the decision;
    // delivery remains asynchronous and never changes the approval ledger.
    require("./purchaseRequestNotifications").queuePurchaseRequestNotification(tx, { db, hotelUid, requestId: op.requestId, request: next, before, event, actor, revision: next.revision });
    tx.set(ref, { ...next, snapshotFingerprint: canonicalDigest(next) });
    tx.create(db.doc(`${ref.path}/history/${String(next.revision).padStart(6, "0")}`), { policyVersion: policy.VERSION, revision: next.revision, event,
      actorUid: actor.uid, actorName: actor.name, reason: reason || null, createdAtMillis: now, snapshot: next, snapshotFingerprint: canonicalDigest(next), createdAt: stamp() });
    for (const value of writes) tx.set(db.doc(budgetPath(hotelUid, value.id)), { ...value, policyVersion: policy.VERSION, year: Number(value.month.slice(0, 4)), currency: settings.currency, updatedAt: stamp(), updatedBy: actor.uid });
    if (reservationChanged || action === "create") tx.set(settingsRef, { ...settings, revision: Math.max(1, settings.revision), ledgerRevision: settings.ledgerRevision + 1, currencyLocked: true,
      usedCategoryIds: [...new Set([...settings.usedCategoryIds, next.budgetCategoryId].filter(Boolean))], usedCostCentreIds: [...new Set([...settings.usedCostCentreIds, next.costCentreId].filter(Boolean))], updatedAt: stamp() });
    saveOperation(tx, op, actor.uid, result); return result;
  });
}
const options = { region: "us-central1", cors: true, timeoutSeconds: 120, memory: "512MiB", concurrency: 4, maxInstances: 5 };
module.exports = { getHotelPurchaseRequestContextHandler, listHotelPurchaseRequestsHandler, getHotelPurchaseRequestHandler,
  mutateHotelPurchaseRequestHandler: guardedCommand(mutateHotelPurchaseRequestHandler, "purchaserequests", (input) => Object.hasOwn(REQUEST_ACTIONS, input.action) ? REQUEST_ACTIONS[input.action] : null),
  getHotelPurchaseBudgetsHandler, saveHotelPurchaseBudgetsHandler: guardedCommand(saveHotelPurchaseBudgetsHandler, "purchasebudgets", "update"), getHotelPurchaseRequestSettingsHandler,
  saveHotelPurchaseRequestSettingsHandler: guardedCommand(saveHotelPurchaseRequestSettingsHandler, "purchasebudgets", "settings"),
  purchaseRequestInternals: { authorize, storedSettings, storedRequest, draftInputFromSnapshot, draftSnapshot, currentApprover, canonicalDigest, requestPath, settingsPath, budgetPath } };
for (const name of ["getHotelPurchaseRequestContext", "listHotelPurchaseRequests", "getHotelPurchaseRequest", "mutateHotelPurchaseRequest", "getHotelPurchaseBudgets", "saveHotelPurchaseBudgets", "getHotelPurchaseRequestSettings", "saveHotelPurchaseRequestSettings"]) module.exports[name] = onCall(options, gated(module.exports[`${name}Handler`]));
