const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("./purchaseRequestPolicy");

test("purchase line totals use exact six-decimal arithmetic and round each net line once", () => {
  assert.equal(policy.lineTotal("0.1", "0.05"), 1);
  assert.equal(policy.lineTotal("0.1", "0.049999"), 0);
  assert.equal(policy.lineTotal("3.333333", "1.234567"), 412);
  assert.equal(policy.lineTotal("999999.999999", "999999.999999"), 99999999999800);
  assert.equal(policy.total([{ lineTotalMinor: 1 }, { lineTotalMinor: 1 }]), 2);
});
test("invalid negative, excessive precision, fractional minor amounts and unsafe totals are rejected", () => {
  for (const value of [-1, Infinity, NaN, "1e-3", "0.0000001", "1000001", "-0"]) assert.throws(() => policy.lineTotal(value, 1));
  for (const value of [-1, 1.1, Number.MAX_SAFE_INTEGER, "100"]) assert.throws(() => policy.money(value, "Budget"));
  assert.throws(() => policy.total([{ lineTotalMinor: policy.MAX_MONEY_MINOR }, { lineTotalMinor: 1 }]));
});
test("pending reservations become commitments without consuming budget twice", () => {
  const budget = policy.budgetProjection({ budgetMinor: 50000, committedMinor: 30000, pendingMinor: 15000 }, "2026-10", "maintenance");
  const pending = { bucketId: budget.id, amountMinor: 15000, state: "pending" }, committed = { ...pending, state: "committed" };
  const result = policy.transferBudget(new Map([[budget.id, budget]]), pending, committed).get(budget.id);
  assert.equal(budget.remainingMinor, 5000); assert.equal(result.remainingMinor, 5000);
  assert.equal(result.pendingMinor, 0); assert.equal(result.committedMinor, 45000);
});
test("moving a reservation releases its original month and category atomically", () => {
  const first = policy.budgetProjection({ budgetMinor: 50000, pendingMinor: 15000 }, "2026-10", "maintenance");
  const second = policy.budgetProjection({ budgetMinor: 50000 }, "2026-11", "china");
  const result = policy.transferBudget(new Map([[first.id, first], [second.id, second]]), { bucketId: first.id, state: "pending", amountMinor: 15000 }, { bucketId: second.id, state: "pending", amountMinor: 18000 });
  assert.equal(result.get(first.id).pendingMinor, 0); assert.equal(result.get(second.id).pendingMinor, 18000);
  assert.equal(first.pendingMinor, 15000, "the original snapshot stays unchanged");
});
test("missing budgets and reservation underflow fail closed instead of rebuilding financial balances", () => {
  const value = policy.budgetProjection(null, "2026-10", "maintenance");
  assert.equal(value.exists, false);
  assert.throws(() => policy.transferBudget(new Map([[value.id, value]]), null, { bucketId: value.id, state: "pending", amountMinor: 100 }));
  const empty = policy.budgetProjection({ budgetMinor: 50000 }, "2026-10", "maintenance");
  assert.throws(() => policy.transferBudget(new Map([[empty.id, empty]]), { bucketId: empty.id, state: "pending", amountMinor: 1 }, null));
});
test("required step thresholds keep configured order and append separate over-budget authority", () => {
  const settings = { approvalSteps: [{ id: "manager", name: "Manager", thresholdMinor: 0 }, { id: "finance", name: "Finance", thresholdMinor: 10000 }], overBudgetMode: "approval" };
  assert.deepEqual(policy.requiredSteps(settings, 10000, true).map((step) => step.id), ["manager", "finance", "over-budget"]);
  assert.deepEqual(policy.requiredSteps(settings, 9999, false).map((step) => step.id), ["manager"]);
  assert.throws(() => policy.requiredSteps({ ...settings, overBudgetMode: "block" }, 9999, true));
  assert.throws(() => policy.requiredSteps({ ...settings, approvalSteps: [] }, 9999, false));
});
test("first-step escalation promotes only the immediate configured successor and preserves required budget authority", () => {
  const settings = { revision: 4, approvalSteps: [{ id: "department", name: "Department", thresholdMinor: 0 }, { id: "finance", name: "Finance", thresholdMinor: 10000 }, { id: "director", name: "Director", thresholdMinor: 50000 }], overBudgetMode: "approval" };
  const low = policy.escalateFirstStep(settings, policy.requiredSteps(settings, 100, true));
  assert.deepEqual(low.steps.map((step) => step.id), ["finance", "over-budget"]);
  assert.deepEqual(low.escalation, { reason: "requester-only-first-step", fromStepId: "department", fromStepName: "Department", toStepId: "finance", toStepName: "Finance", settingsRevision: 4 });
  assert.deepEqual(policy.escalateFirstStep(settings, policy.requiredSteps(settings, 50000, false)).steps.map((step) => step.id), ["finance", "director"]);
  assert.throws(() => policy.escalateFirstStep({ ...settings, approvalSteps: [settings.approvalSteps[0]] }, [{ id: "department", name: "Department" }]));
});
test("settings reject unsupported currency scales, forged step authority and reserved extra-step identities", () => {
  const valid = { ...policy.DEFAULT_SETTINGS, currency: "EUR", approvalSteps: [{ id: "manager", name: "Manager", thresholdMinor: 0 }], approvers: [{ uid: "manager", stepIds: ["manager"], limitMinor: 10000, canApproveOverBudget: false }] };
  assert.equal(policy.normalizeSettings(valid).currency, "EUR");
  for (const currency of ["JPY", "KWD", "XXX", "eur"]) assert.throws(() => policy.normalizeSettings({ ...valid, currency }));
  assert.throws(() => policy.normalizeSettings({ ...valid, approvers: [{ ...valid.approvers[0], stepIds: ["finance"] }] }));
  assert.throws(() => policy.normalizeSettings({ ...valid, approvalSteps: [{ id: "over-budget", name: "Bypass", thresholdMinor: 0 }] }));
});
test("drafts retain explicit zero quotes while rejecting arbitrary audit fields and duplicate lines", () => {
  const line = { id: "line", kind: "free", description: "Warranty repair", quantity: 1, unitPrice: 0, unit: "service" };
  assert.equal(policy.normalizeDraft({ lines: [line] }).lines[0].unitPrice, 0);
  assert.throws(() => policy.normalizeDraft({ lines: [line], totalMinor: 1 }));
  assert.throws(() => policy.normalizeDraft({ lines: [line, line] }));
  assert.throws(() => policy.normalizeDraft({ lines: [{ ...line, approved: true }] }));
});
test("line supplier references preserve absent legacy payload keys and explicit unfinished selections", () => {
  const line = { id: "line", kind: "free", description: "Repair", quantity: 1, unitPrice: 10, unit: "service" };
  const legacy = policy.normalizeDraft({ supplierId: "old-vendor", lines: [line] });
  assert.equal(Object.hasOwn(legacy.lines[0], "supplierId"), false);
  assert.equal(legacy.supplierId, "old-vendor");
  assert.equal(policy.normalizeDraft({ supplierId: "old-vendor", lines: [{ ...line, supplierId: "" }] }).lines[0].supplierId, "");
  assert.equal(policy.normalizeDraft({ lines: [{ ...line, supplierId: "line-vendor" }] }).lines[0].supplierId, "line-vendor");
  for (const supplierId of ["foreign/path", "..", 123]) assert.throws(() => policy.normalizeDraft({ lines: [{ ...line, supplierId }] }));
  assert.throws(() => policy.normalizeDraft({ lines: [{ ...line, supplier: { id: "forged", name: "Forged" } }] }));
});
