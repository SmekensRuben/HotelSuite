import { describe, expect, it } from "vitest";
import { buildPurchaseBudgetDraft, changedPurchaseBudgets, purchaseBudgetTotals, purchaseMoneyToMinor } from "./purchaseBudgetDraft";

const categories = [{ id: "maintenance", name: "Maintenance" }];
const budgets = [{ month: "2026-01", categoryId: "maintenance", budgetMinor: 50000, openingUsedMinor: 0, pendingMinor: 15000, committedMinor: 30000, remainingMinor: 5000, revision: 4 }];

describe("purchase budget draft boundary", () => {
  it("converts decimal amounts exactly without floating-point rounding or implicit blank zeroes", () => {
    expect(purchaseMoneyToMinor("100.29")).toBe(10029);
    expect(purchaseMoneyToMinor("0.01")).toBe(1);
    expect(purchaseMoneyToMinor("0")).toBe(0);
    for (const value of ["", " ", "1.001", "-1", "1e3", "Infinity", "1,000", "0.009", "99999999999999999"]) expect(() => purchaseMoneyToMinor(value)).toThrow();
  });
  it("distinguishes missing budgets from explicit zero and keeps reviewed revisions", () => {
    const draft = buildPurchaseBudgetDraft(budgets);
    draft["2026-02:maintenance"] = { budget: "", opening: "" };
    expect(changedPurchaseBudgets(draft, budgets, 2026, categories)).toEqual([]);
    draft["2026-02:maintenance"].budget = "0.00";
    draft["2026-01:maintenance"].opening = "100.00";
    expect(changedPurchaseBudgets(draft, budgets, 2026, categories)).toEqual([
      { month: "2026-01", categoryId: "maintenance", budgetMinor: 50000, openingUsedMinor: 10000, expectedRevision: 4 },
      { month: "2026-02", categoryId: "maintenance", budgetMinor: 0, openingUsedMinor: 0, expectedRevision: 0 },
    ]);
  });
  it("does not clear saved allocations or accept opening spending without an allocation", () => {
    expect(() => changedPurchaseBudgets({ "2026-01:maintenance": { budget: "", opening: "0" } }, budgets, 2026, categories)).toThrow("cannot be cleared");
    expect(() => changedPurchaseBudgets({ "2026-02:maintenance": { budget: "", opening: "30" } }, budgets, 2026, categories)).toThrow("before recording opening consumption");
  });
  it("ignores another year's draft entries and unknown category identities", () => {
    expect(changedPurchaseBudgets({ "2025-01:maintenance": { budget: "5", opening: "0" }, "2026-01:other": { budget: "5", opening: "0" } }, budgets, 2026, categories)).toEqual([]);
  });
  it("shows approved and pending separately without double subtraction", () => {
    expect(purchaseBudgetTotals(budgets)).toEqual({ allocated: 50000, opening: 0, pending: 15000, committed: 30000, remaining: 5000 });
    expect(purchaseBudgetTotals([{ ...budgets[0], pendingMinor: 0, committedMinor: 45000 }]).remaining).toBe(5000);
  });
  it("keeps oversized annual changes out of the durable command recovery queue", () => {
    const manyCategories = Array.from({ length: 21 }, (_, index) => ({ id: `category-${index}` }));
    const draft = Object.fromEntries(manyCategories.flatMap(({ id }) => Array.from({ length: 12 }, (_, index) => [`2026-${String(index + 1).padStart(2, "0")}:${id}`, { budget: "100.00", opening: "0.00" }])));
    expect(() => changedPurchaseBudgets(draft, [], 2026, manyCategories)).toThrow("at most 240");
  });
});
