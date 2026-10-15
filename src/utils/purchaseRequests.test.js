import { expect, it } from "vitest";
import { eligibleRequestApprovers, purchaseRequestLineSupplier, purchaseRequestLineSupplierLabel, purchaseRequestSupplierSummary, requestBudgetImpact, requestLineTotalMinor } from "./purchaseRequests";

it("rounds each net purchase line half up using the same six-decimal arithmetic as the server", () => {
  expect(requestLineTotalMinor([{ quantity: "1", unitPrice: "1.005" }])).toBe(101);
  expect(requestLineTotalMinor([{ quantity: "1", unitPrice: "0.145" }])).toBe(15);
  expect(requestLineTotalMinor([{ quantity: "3", unitPrice: "0.335" }])).toBe(101);
  expect(requestLineTotalMinor([{ quantity: "1", unitPrice: "1.005" }, { quantity: "1", unitPrice: "1.005" }])).toBe(202);
  expect(requestLineTotalMinor([{ quantity: "0.000001", unitPrice: "0.000001" }])).toBe(0);
  expect(requestLineTotalMinor([{ quantity: "1000000", unitPrice: "1000000" }])).toBe(100000000000000);
});
it("keeps unknown, invalid or unsafe estimates unavailable rather than showing zero budget impact", () => {
  for (const line of [{ quantity: "1", unitPrice: "" }, { quantity: "0", unitPrice: "1" }, { quantity: "-1", unitPrice: "1" }, { quantity: "1", unitPrice: "1.0000001" }, { quantity: "1000001", unitPrice: "1" }, { quantity: "1e6", unitPrice: "1" }]) expect(requestLineTotalMinor([line])).toBeNull();
  expect(requestLineTotalMinor([{ quantity: "1000000", unitPrice: "1000000" }, { quantity: "1", unitPrice: "1" }])).toBeNull();
  expect(requestLineTotalMinor([{ quantity: "1", unitPrice: "0" }])).toBe(0);
});
it("replaces the held returned amount when previewing a resubmission without counting it twice", () => {
  expect(requestBudgetImpact({ remainingMinor: 5000 }, 15000, 15000)).toEqual({ missing: false, remainingMinor: 5000, afterMinor: 5000, overBudget: false });
  expect(requestBudgetImpact({ remainingMinor: 5000 }, 20000, 15000).afterMinor).toBe(0);
  expect(requestBudgetImpact(null, 15000).missing).toBe(true);
  expect(requestBudgetImpact({ remainingMinor: 0 }, 1).overBudget).toBe(true);
});
it("offers only non-requester currently eligible approvers with the step and amount authority", () => {
  const context = { approvers: [{ uid: "requester", stepIds: ["manager"], limitMinor: 50000 }, { uid: "revoked", stepIds: ["manager"], limitMinor: 50000, eligible: false }, { uid: "small", stepIds: ["manager"], limitMinor: 100 }, { uid: "wrong", stepIds: ["finance"], limitMinor: 50000 }, { uid: "manager", stepIds: ["manager"], limitMinor: 50000, eligible: true }] };
  expect(eligibleRequestApprovers(context, "requester", "manager", 15000).map((row) => row.uid)).toEqual(["manager"]);
});
it("summarizes distinct saved line suppliers in first-line order without hiding mixed requests", () => {
  const a = { id: "a", name: "Hotel Supplies" }, b = { id: "b", name: "Local Repairs" };
  expect(purchaseRequestSupplierSummary({ supplier: null, lines: [{ supplierId: "b", supplier: b }, { supplierId: "a", supplier: a }, { supplierId: "b", supplier: b }] })).toEqual({
    suppliers: [b, a], unassignedLineCount: 0, label: "Multiple suppliers (2)", details: "Local Repairs · Hotel Supplies",
  });
  expect(purchaseRequestSupplierSummary({ supplier: a, lines: [{ supplierId: "a", supplier: a }, { supplierId: "", supplier: null }] })).toEqual({
    suppliers: [a], unassignedLineCount: 1, label: "Hotel Supplies", details: "1 line without a supplier",
  });
});
it("inherits only legacy absent line suppliers and preserves explicit blanks and incomplete snapshots", () => {
  const request = { supplier: { id: "old", name: "Saved supplier name" } };
  expect(purchaseRequestLineSupplierLabel({}, request)).toBe("Saved supplier name");
  expect(purchaseRequestLineSupplier({ supplierId: "", supplier: { id: "old", name: "Wrong inherited value" } }, request)).toBeNull();
  expect(purchaseRequestLineSupplierLabel({ supplierId: null }, request)).toBe("Supplier not selected");
  expect(purchaseRequestLineSupplierLabel({ supplierId: "different", supplier: request.supplier }, request)).toBe("Supplier details unavailable");
  expect(purchaseRequestLineSupplierLabel({ supplier: { id: "line", name: "Frozen line supplier" } }, request)).toBe("Frozen line supplier");
  expect(purchaseRequestSupplierSummary({ ...request, lines: [{}, {}] }).label).toBe("Saved supplier name");
});
it("uses supplier snapshots for line-free summaries without consulting mutable supplier records", () => {
  expect(purchaseRequestSupplierSummary({ suppliers: [{ id: "a", name: "Historic A" }, { id: "b", name: "Historic B" }] }).label).toBe("Multiple suppliers (2)");
  expect(purchaseRequestSupplierSummary({}).label).toBe("Supplier not selected");
});
