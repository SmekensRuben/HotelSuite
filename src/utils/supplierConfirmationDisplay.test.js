import { expect, it } from "vitest";
import { supplierConfirmationStatus } from "./supplierConfirmationDisplay";
const aggregate = (patch = {}) => ({ policyVersion: 1, responseId: "one", reviewId: null, responseType: "accepted", respondedOn: "2026-10-13", eventCount: 1, reviewState: "not-required", requiresAttention: false, ...patch });
it("dispatch, supplier acceptance, changes and finalization remain distinct", () => {
  expect(supplierConfirmationStatus({ status: "Ordered", dispatchStatus: "sent" })).toEqual({ label: "No response recorded", attention: true });
  expect(supplierConfirmationStatus({ status: "Created" }).attention).toBe(false);
  expect(supplierConfirmationStatus({ status: "Ordered", supplierConfirmation: aggregate() }).label).toBe("Supplier accepted");
  const pending = aggregate({ responseType: "changes-proposed", reviewState: "pending", requiresAttention: true });
  expect(supplierConfirmationStatus({ status: "Ordered", supplierConfirmation: pending }).label).toMatch(/needs review/);
  expect(supplierConfirmationStatus({ status: "Finalized", supplierConfirmation: pending }).attention).toBe(false);
  expect(supplierConfirmationStatus({ status: "Ordered", supplierConfirmation: { ...pending, reviewId: "review", reviewState: "accepted", requiresAttention: false } }).label).toMatch(/hotel accepted/);
});
it("corrupt aggregate combinations do not appear accepted or disappear from the attention queue", () => {
  for (const supplierConfirmation of [null, {}, aggregate({ requiresAttention: true }), aggregate({ responseId: "" }), aggregate({ reviewState: "accepted" }),
    aggregate({ responseType: "rejected", reviewState: "accepted", reviewId: "review" })]) {
    expect(supplierConfirmationStatus({ status: "Ordered", supplierConfirmation })).toMatchObject({ invalid: true, attention: true });
  }
});
