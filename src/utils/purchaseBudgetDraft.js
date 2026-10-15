export const PURCHASE_BUDGET_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const MAX_PURCHASE_BUDGET_CHANGES = 240;

/** Decimal input stays text until a deliberate save; a blank allocation is not a zero budget. */
export function purchaseMoneyToMinor(value) {
  const text = String(value ?? "").trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) throw new Error("Enter a non-negative amount with no more than two decimal places.");
  const [whole, fraction = ""] = text.split(".");
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor) || minor > 100000000000000) throw new Error("This amount is too large.");
  return minor;
}

export function purchaseMinorToInput(value) {
  return Number.isSafeInteger(value) && value >= 0 ? (value / 100).toFixed(2) : "";
}

export function purchaseBudgetKey(month, categoryId) {
  return `${month}:${categoryId}`;
}

export function buildPurchaseBudgetDraft(budgets = []) {
  return Object.fromEntries(budgets.map((budget) => [purchaseBudgetKey(budget.month, budget.categoryId), {
    budget: purchaseMinorToInput(budget.budgetMinor),
    opening: purchaseMinorToInput(budget.openingUsedMinor ?? 0),
  }]));
}

export function changedPurchaseBudgets(draft, budgets, year, categories) {
  const previous = new Map(budgets.map((budget) => [purchaseBudgetKey(budget.month, budget.categoryId), budget]));
  const categoryIds = new Set(categories.map((category) => category.id));
  const changed = Object.entries(draft).flatMap(([key, row]) => {
    const separator = key.indexOf(":");
    const month = key.slice(0, separator), categoryId = key.slice(separator + 1);
    if (!month.startsWith(`${year}-`) || !categoryIds.has(categoryId)) return [];
    const saved = previous.get(key);
    if (row.budget.trim() === "") {
      if (saved) throw new Error("An existing allocation cannot be cleared. Enter 0 for an explicit zero budget.");
      if (String(row.opening || "").trim() && purchaseMoneyToMinor(row.opening) > 0) throw new Error("Enter an allocation before recording opening consumption.");
      return [];
    }
    const budgetMinor = purchaseMoneyToMinor(row.budget), openingUsedMinor = purchaseMoneyToMinor(row.opening || "0");
    if (saved?.budgetMinor === budgetMinor && (saved.openingUsedMinor ?? 0) === openingUsedMinor) return [];
    return [{ month, categoryId, budgetMinor, openingUsedMinor, expectedRevision: saved?.revision ?? 0 }];
  });
  if (changed.length > MAX_PURCHASE_BUDGET_CHANGES) throw new Error("Save at most 240 monthly allocations together. Discard a category's draft changes to reduce this batch, then save before editing more categories.");
  return changed;
}

export function purchaseBudgetChangeCount(draft, budgets) {
  const previous = new Map(budgets.map((budget) => [purchaseBudgetKey(budget.month, budget.categoryId), budget]));
  return Object.entries(draft).filter(([key, row]) => {
    const saved = previous.get(key);
    if (!saved && !row.budget.trim() && !String(row.opening || "").trim()) return false;
    try {
      return !saved || purchaseMoneyToMinor(row.budget) !== saved.budgetMinor || purchaseMoneyToMinor(row.opening || "0") !== (saved.openingUsedMinor || 0);
    } catch { return true; }
  }).length;
}

export function purchaseBudgetTotals(budgets = []) {
  return budgets.reduce((total, row) => ({
    allocated: total.allocated + row.budgetMinor,
    opening: total.opening + (row.openingUsedMinor || 0),
    pending: total.pending + (row.pendingMinor || 0),
    committed: total.committed + (row.committedMinor || 0),
    remaining: total.remaining + (row.remainingMinor ?? row.budgetMinor - (row.openingUsedMinor || 0) - (row.pendingMinor || 0) - (row.committedMinor || 0)),
  }), { allocated: 0, opening: 0, pending: 0, committed: 0, remaining: 0 });
}
