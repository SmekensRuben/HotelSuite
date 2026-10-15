const { HttpsError } = require("firebase-functions/v2/https");
const { text } = require("./validation");

const VERSION = 1;
const MAX_MONEY_MINOR = 100000000000000;
const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "CAD", "AUD"];
const DEFAULT_SETTINGS = { currency: "EUR", costCentres: [], budgetCategories: [], approvalSteps: [], approvers: [], overBudgetMode: "block" };
const SETTINGS_FIELDS = Object.keys(DEFAULT_SETTINGS);
function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) throw new HttpsError("invalid-argument", `Unsupported ${label} field.`);
}
function id(value, label = "ID") {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new HttpsError("invalid-argument", `${label} must use letters, numbers, hyphens or underscores.`);
  return value;
}
function money(value, label, { signed = false } = {}) {
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_MONEY_MINOR || !signed && value < 0) throw new HttpsError("invalid-argument", `${label} must be a safe amount in minor currency units.`);
  return value;
}
function month(value) {
  if (typeof value !== "string" || !/^(20\d{2}|2100)-(0[1-9]|1[0-2])$/.test(value)) throw new HttpsError("invalid-argument", "Choose a budget month in YYYY-MM format.");
  return value;
}
function micro(value, label, positive = false) {
  const raw = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof raw !== "string" || !/^\d{1,7}(\.\d{1,6})?$/.test(raw)) throw new HttpsError("invalid-argument", `${label} must have at most six decimal places.`);
  const [whole, fraction = ""] = raw.split("."), result = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"));
  if (result > 1000000000000n || positive && result === 0n) throw new HttpsError("invalid-argument", `${label} must be ${positive ? "positive and " : ""}at most 1,000,000.`);
  return result;
}
function decimal(value, label, positive = false) { return Number(micro(value, label, positive)) / 1000000; }
function lineTotal(quantity, unitPrice) {
  const product = micro(quantity, "Quantity", true) * micro(unitPrice, "Net unit price");
  return money(Number((product + 5000000000n) / 10000000000n), "Line total");
}
function total(lines) { return lines.reduce((sum, line) => money(sum + line.lineTotalMinor, "Request total"), 0); }
function namedRows(value, label, maximum) {
  if (!Array.isArray(value) || value.length > maximum) throw new HttpsError("invalid-argument", `${label} must contain at most ${maximum} entries.`);
  const rows = value.map((row) => { exact(row, ["id", "name"], label); return { id: id(row.id, `${label} ID`), name: text(row.name, label, 100, true) }; });
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new HttpsError("invalid-argument", `${label} IDs must be unique.`);
  return rows;
}
function normalizeSettings(input) {
  exact(input, SETTINGS_FIELDS, "purchase request setting");
  if (!CURRENCIES.includes(input.currency)) throw new HttpsError("invalid-argument", "Choose a supported two-decimal currency: EUR, USD, GBP, CHF, CAD or AUD.");
  if (!["block", "approval"].includes(input.overBudgetMode)) throw new HttpsError("invalid-argument", "Choose whether excess budgets are blocked or require additional approval.");
  const costCentres = namedRows(input.costCentres, "Cost centre", 100), budgetCategories = namedRows(input.budgetCategories, "Budget category", 100);
  if (!Array.isArray(input.approvalSteps) || input.approvalSteps.length > 8) throw new HttpsError("invalid-argument", "Configure at most eight ordered approval steps.");
  const approvalSteps = input.approvalSteps.map((row) => {
    exact(row, ["id", "name", "thresholdMinor"], "approval step");
    const stepId = id(row.id, "Approval step ID");
    if (stepId === "over-budget") throw new HttpsError("invalid-argument", "The over-budget step is reserved for additional budget authority.");
    return { id: stepId, name: text(row.name, "Approval step name", 100, true), thresholdMinor: money(row.thresholdMinor ?? 0, "Approval threshold") };
  });
  if (new Set(approvalSteps.map((step) => step.id)).size !== approvalSteps.length) throw new HttpsError("invalid-argument", "Approval step IDs must be unique.");
  if (!Array.isArray(input.approvers) || input.approvers.length > 100) throw new HttpsError("invalid-argument", "Configure at most 100 approval authorities.");
  const approvers = input.approvers.map((row) => {
    exact(row, ["uid", "stepIds", "limitMinor", "canApproveOverBudget"], "approval authority");
    if (typeof row.uid !== "string" || !row.uid || row.uid.length > 128 || /[\/\\\u0000-\u001f]/.test(row.uid)) throw new HttpsError("invalid-argument", "An approval authority needs a valid user ID.");
    if (!Array.isArray(row.stepIds) || new Set(row.stepIds).size !== row.stepIds.length || row.stepIds.some((stepId) => !approvalSteps.some((step) => step.id === stepId))) throw new HttpsError("invalid-argument", "An approver's steps must refer to configured approval steps.");
    if (typeof row.canApproveOverBudget !== "boolean") throw new HttpsError("invalid-argument", "Choose whether each approver has additional budget authority.");
    return { uid: row.uid, stepIds: row.stepIds, limitMinor: money(row.limitMinor, "Approval limit"), canApproveOverBudget: row.canApproveOverBudget };
  });
  if (new Set(approvers.map((row) => row.uid)).size !== approvers.length) throw new HttpsError("invalid-argument", "Configure each approver only once.");
  return { currency: input.currency, costCentres, budgetCategories, approvalSteps, approvers, overBudgetMode: input.overBudgetMode };
}
function normalizeDraft(input) {
  exact(input, ["supplierId", "title", "description", "motivation", "costCentreId", "budgetCategoryId", "budgetMonth", "lines", "attachmentIds"], "purchase request draft");
  const reference = (value, label) => value == null || value === "" ? "" : id(value, label);
  if (!Array.isArray(input.lines) || input.lines.length > 50) throw new HttpsError("invalid-argument", "A request may contain at most 50 purchase lines.");
  const lines = input.lines.map((line) => {
    exact(line, ["id", "kind", "supplierProductId", "purchaseOptionId", "description", "quantity", "unitPrice", "unit"], "purchase line");
    if (!["free", "supplier"].includes(line.kind)) throw new HttpsError("invalid-argument", "Choose a supplier product or a free purchase line.");
    const result = { id: id(line.id, "Line ID"), kind: line.kind, description: text(line.description ?? "", "Line description", 500),
      quantity: decimal(line.quantity, "Quantity", true), unit: text(line.unit ?? "", "Line unit", 100) };
    if (line.unitPrice !== undefined && line.unitPrice !== null && line.unitPrice !== "") result.unitPrice = decimal(line.unitPrice, "Net unit price");
    if (line.kind === "free" && result.unitPrice === undefined) throw new HttpsError("invalid-argument", "Enter a net unit price for each free line.");
    if (line.kind === "supplier") {
      result.supplierProductId = id(line.supplierProductId, "Supplier product ID");
      result.purchaseOptionId = line.purchaseOptionId == null || line.purchaseOptionId === "" ? "default" : id(line.purchaseOptionId, "Purchase option ID");
    }
    return result;
  });
  if (new Set(lines.map((line) => line.id)).size !== lines.length) throw new HttpsError("invalid-argument", "Purchase line IDs must be unique.");
  const attachmentIds = input.attachmentIds ?? [];
  if (!Array.isArray(attachmentIds) || attachmentIds.length > 10 || new Set(attachmentIds).size !== attachmentIds.length || attachmentIds.some((value) => typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value))) throw new HttpsError("invalid-argument", "Select at most ten distinct uploaded attachments.");
  return { supplierId: reference(input.supplierId, "Supplier ID"), title: text(input.title ?? "", "Title", 200), description: text(input.description ?? "", "Description", 3000),
    motivation: text(input.motivation ?? "", "Motivation", 3000), costCentreId: reference(input.costCentreId, "Cost centre ID"), budgetCategoryId: reference(input.budgetCategoryId, "Budget category ID"),
    budgetMonth: input.budgetMonth == null || input.budgetMonth === "" ? "" : month(input.budgetMonth), lines, attachmentIds };
}
const bucketId = (value, categoryId) => `${month(value)}__${id(categoryId, "Budget category ID")}`;
function budgetProjection(raw, monthValue, categoryId) {
  const exists = raw != null, data = raw || {};
  const result = { id: bucketId(monthValue, categoryId), month: monthValue, categoryId, exists, revision: data.revision ?? 0,
    budgetMinor: money(data.budgetMinor ?? 0, "Budget"), openingUsedMinor: money(data.openingUsedMinor ?? 0, "Opening used amount"),
    pendingMinor: money(data.pendingMinor ?? 0, "Pending requests"), committedMinor: money(data.committedMinor ?? 0, "Approved commitments") };
  result.remainingMinor = money(result.budgetMinor - result.openingUsedMinor - result.pendingMinor - result.committedMinor, "Available budget", { signed: true });
  return result;
}
function transferBudget(budgets, beforeReservation, afterReservation) {
  const result = new Map([...budgets].map(([key, value]) => [key, { ...value }]));
  for (const [reservation, sign] of [[beforeReservation, -1], [afterReservation, 1]]) {
    if (!reservation || reservation.state === "none") continue;
    const value = result.get(reservation.bucketId);
    if (!value?.exists) throw new HttpsError("failed-precondition", "The reserved budget is missing. Reconcile it before changing this request.");
    const field = reservation.state === "pending" ? "pendingMinor" : reservation.state === "committed" ? "committedMinor" : null;
    if (!field) throw new HttpsError("failed-precondition", "The request's budget reservation needs reconciliation.");
    value[field] += sign * money(reservation.amountMinor, "Reserved amount");
    if (!Number.isSafeInteger(value[field]) || value[field] < 0 || value[field] > MAX_MONEY_MINOR) throw new HttpsError("failed-precondition", "The budget ledger needs reconciliation; no request was changed.");
  }
  for (const value of result.values()) value.remainingMinor = money(value.budgetMinor - value.openingUsedMinor - value.pendingMinor - value.committedMinor, "Available budget", { signed: true });
  return result;
}
function requiredSteps(settings, amount, overBudget) {
  const steps = settings.approvalSteps.filter((step) => amount >= step.thresholdMinor).map(({ id: stepId, name }) => ({ id: stepId, name }));
  if (!steps.length) throw new HttpsError("failed-precondition", "Configure at least one applicable approval step before submitting requests.");
  if (overBudget) {
    if (settings.overBudgetMode === "block") throw new HttpsError("failed-precondition", "This request exceeds the available budget.");
    steps.push({ id: "over-budget", name: "Additional budget approval" });
  }
  return steps;
}
function escalateFirstStep(settings, steps) {
  const first = steps[0], index = settings.approvalSteps.findIndex((step) => step.id === first?.id), target = settings.approvalSteps[index + 1];
  if (index < 0 || !target) throw new HttpsError("failed-precondition", "The requester is the only current approver for the first step. Configure an independent approver for the next approval step before submitting.");
  return { steps: [{ id: target.id, name: target.name }, ...steps.slice(1).filter((step) => step.id !== target.id)],
    escalation: { reason: "requester-only-first-step", fromStepId: first.id, fromStepName: first.name, toStepId: target.id, toStepName: target.name, settingsRevision: settings.revision } };
}
function authorityAllows(authority, stepId, amount) {
  return !!authority && authority.limitMinor >= amount && (stepId === "over-budget" ? authority.canApproveOverBudget === true : authority.stepIds.includes(stepId));
}
module.exports = { VERSION, MAX_MONEY_MINOR, CURRENCIES, DEFAULT_SETTINGS, SETTINGS_FIELDS, exact, id, money, month, micro, decimal, lineTotal, total,
  normalizeSettings, normalizeDraft, bucketId, budgetProjection, transferBudget, requiredSteps, escalateFirstStep, authorityAllows };
