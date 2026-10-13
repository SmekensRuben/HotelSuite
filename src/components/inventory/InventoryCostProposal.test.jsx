import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ proposal: vi.fn(), auth: { currentUser: { uid: "counter" } } }));
vi.mock("../../firebaseConfig", () => ({ auth: mocks.auth }));
vi.mock("../../services/firebaseInventoryCostProposals", () => ({ getInventoryCostProposal: mocks.proposal }));
import InventoryCostProposal from "./InventoryCostProposal";
import { invalidateProcurementReads } from "../../services/procurementReadPool";
const request = { hotelUid: "hotel-a", purpose: "movement", locationId: "store", catalogProductId: "juice", businessDate: "2026-10-12" };
const proposal = { ...request, stockCountId: null, available: true, status: "available", costProposalPolicyVersion: 1, netUnitCost: 2.666667, baseUnit: "l", currency: "EUR", asOfMillis: 1791800000000,
  source: { openingBusinessDate: "2026-10-01", openingQuantity: 10, weightedSourceQuantity: 30, weightedSourceNetValue: 80, postingCutoffSequence: 3, movementCount: 2 }, reasons: [], costBasis: "Recorded source estimate, not live valuation." };
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const show = (props = {}) => render(<InventoryCostProposal request={request} baseUnit="l" currency="EUR" businessDate={request.businessDate} articleName="Orange juice" onApply={vi.fn()} {...props} />);
beforeEach(() => { vi.clearAllMocks(); mocks.auth.currentUser = { uid: "counter" }; invalidateProcurementReads(); mocks.proposal.mockResolvedValue(proposal); });
it("loads only on explicit request, displays its dated source evidence, and applies only on an explicit second action", async () => {
  const apply = vi.fn(); show({ onApply: apply }); expect(mocks.proposal).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Suggest unit cost for Orange juice" }));
  const button = await screen.findByRole("button", { name: "Apply cost estimate for Orange juice" });
  expect(apply).not.toHaveBeenCalled(); expect(screen.getByText(/2026-10-01 · 10 l/)).toBeInTheDocument();
  expect(screen.getByText(/2026-10-12 · sequence 3/)).toBeInTheDocument(); expect(screen.getByText(/not live stock valuation/)).toBeInTheDocument();
  expect(mocks.proposal).toHaveBeenCalledWith(request, { baseUnit: "l", currency: "EUR", businessDate: request.businessDate });
  fireEvent.click(button); expect(apply).toHaveBeenCalledWith(2.666667, proposal);
});
it("supports an explicitly known zero but never applies unavailable or failed evidence", async () => {
  const apply = vi.fn(); mocks.proposal.mockResolvedValueOnce({ ...proposal, netUnitCost: 0 }); show({ onApply: apply });
  fireEvent.click(screen.getByRole("button", { name: "Suggest unit cost for Orange juice" })); fireEvent.click(await screen.findByRole("button", { name: "Apply cost estimate for Orange juice" })); expect(apply.mock.calls[0][0]).toBe(0);
  mocks.proposal.mockResolvedValueOnce({ ...proposal, available: false, netUnitCost: null, source: null, reasons: [{ code: "missing", detail: "A completed opening count is unavailable." }] });
  fireEvent.click(screen.getByRole("button", { name: "Suggest unit cost for Orange juice" }));
  expect(await screen.findByText("Weighted estimate unavailable")).toBeInTheDocument(); expect(screen.queryByRole("button", { name: "Apply cost estimate for Orange juice" })).not.toBeInTheDocument();
  mocks.proposal.mockRejectedValueOnce(new Error("Read access denied")); fireEvent.click(screen.getByRole("button", { name: "Suggest unit cost for Orange juice" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Read access denied"); expect(apply).toHaveBeenCalledTimes(1);
});
it("provides visible progress and ignores a late calculation after date or same-UID Auth object changes", async () => {
  const waiting = deferred(), apply = vi.fn(); mocks.proposal.mockReturnValueOnce(waiting.promise);
  const view = show({ onApply: apply }); fireEvent.click(screen.getByRole("button", { name: "Suggest unit cost for Orange juice" }));
  expect(screen.getByRole("status")).toHaveTextContent("Reviewing recorded stock-cost evidence");
  expect(screen.getByRole("button", { name: "Suggest unit cost for Orange juice" })).toBeDisabled();
  view.rerender(<InventoryCostProposal request={{ ...request, businessDate: "2026-10-13" }} baseUnit="l" currency="EUR" businessDate="2026-10-13" articleName="Orange juice" onApply={apply} />);
  await act(async () => waiting.resolve(proposal)); expect(screen.queryByRole("button", { name: "Apply cost estimate for Orange juice" })).not.toBeInTheDocument();
  const switched = deferred(); mocks.proposal.mockReturnValueOnce(switched.promise); fireEvent.click(screen.getByRole("button", { name: "Suggest unit cost for Orange juice" })); mocks.auth.currentUser = { uid: "counter" };
  await act(async () => switched.resolve(proposal)); expect(screen.queryByRole("button", { name: "Apply cost estimate for Orange juice" })).not.toBeInTheDocument(); expect(apply).not.toHaveBeenCalled();
});
it("invalidates Apply immediately after access or underlying evidence changes even before rerender", async () => {
  const apply = vi.fn(); show({ onApply: apply }); fireEvent.click(screen.getByRole("button", { name: "Suggest unit cost for Orange juice" }));
  const button = await screen.findByRole("button", { name: "Apply cost estimate for Orange juice" }); invalidateProcurementReads(request.hotelUid); fireEvent.click(button);
  expect(apply).not.toHaveBeenCalled(); expect(await screen.findByRole("alert")).toHaveTextContent(/Hotel access or recorded evidence changed/);
});
it("does not request a calculation for missing context or when another command is pending", () => {
  const view = show({ currency: null }); expect(screen.getByRole("button", { name: "Suggest unit cost for Orange juice" })).toBeDisabled();
  view.rerender(<InventoryCostProposal request={request} baseUnit="l" currency="EUR" businessDate={request.businessDate} disabled onApply={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Suggest unit cost" })).toBeDisabled(); expect(mocks.proposal).not.toHaveBeenCalled();
});
