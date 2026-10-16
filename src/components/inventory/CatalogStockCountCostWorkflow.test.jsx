import React from "react";
import { MemoryRouter } from "react-router-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: { currentUser: { uid: "counter" } }, proposal: vi.fn(), save: vi.fn(), finish: vi.fn() }));
vi.mock("../../firebaseConfig", () => ({ auth: mocks.auth }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: (feature, action) => feature === "stockcounts" && ["read", "update"].includes(action) }));
vi.mock("../../services/firebaseProducts", () => ({ getCatalogProducts: vi.fn() }));
vi.mock("../../services/firebaseStockCounts", () => ({ getStockCountById: vi.fn(), getPendingStockCountMutation: () => null, retryPendingStockCountMutation: vi.fn(), updateStockCountLocationCounts: mocks.save, finishStockCountLocation: mocks.finish, getStockCountPackageOptions: vi.fn(), getStockCountProductChoices: vi.fn() }));
vi.mock("../../services/firebaseInventoryCostProposals", () => ({ getInventoryCostProposal: mocks.proposal }));
import CatalogStockCountLocationPanel from "./CatalogStockCountLocationPanel";
const stockCount = { id: "count", status: "In Progress", currency: "EUR", businessDate: "2026-10-12", revision: 5 };
const location = { locationId: "store", locationName: "Storeroom", status: "In Progress", stockTemplate: { items: [{ catalogProductId: "juice", catalogProductName: "Orange juice", baseUnit: "l" }] }, countedItems: [] };
const proposal = { hotelUid: "hotel-a", purpose: "stockcount", locationId: "store", catalogProductId: "juice", stockCountId: "count", businessDate: stockCount.businessDate, costProposalPolicyVersion: 1,
  available: true, netUnitCost: 2.666667, baseUnit: "l", currency: "EUR", asOfMillis: 1791800000000, source: { anchorStockCountId: "opening", anchorCheckpointId: "cp1", openingBusinessDate: "2026-10-01", openingQuantity: 10, openingNetValue: 20,
    recordedMovementQuantity: 20, recordedMovementNetValue: 60, weightedSourceQuantity: 30, weightedSourceNetValue: 80, postingCutoffSequence: 3, movementCount: 2 }, reasons: [], costBasis: "Recorded source estimate, not live valuation." };
const show = (count = stockCount) => <MemoryRouter><CatalogStockCountLocationPanel hotelUid="hotel-a" stockCount={count} location={location} /></MemoryRouter>;
const openValuation = () => fireEvent.click(screen.getByText("Valuation (optional)"));
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); mocks.auth.currentUser = { uid: "counter" }; mocks.proposal.mockResolvedValue(proposal); mocks.save.mockResolvedValue({}); mocks.finish.mockResolvedValue({}); });
it("keeps counts and manually entered costs unchanged until Apply, then saves only the frozen reviewed number", async () => {
  render(show()); openValuation(); fireEvent.change(screen.getByLabelText("Count Orange juice"), { target: { value: "12.5" } }); fireEvent.change(screen.getByLabelText("Unit cost Orange juice"), { target: { value: "7" } });
  expect(mocks.proposal).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Suggest unit cost for Orange juice" }));
  const apply = await screen.findByRole("button", { name: "Apply cost estimate for Orange juice" });
  expect(screen.getByLabelText("Unit cost Orange juice")).toHaveValue(7); expect(screen.getByLabelText("Count Orange juice")).toHaveValue(12.5);
  expect(mocks.proposal).toHaveBeenCalledWith({ hotelUid: "hotel-a", purpose: "stockcount", stockCountId: "count", locationId: "store", catalogProductId: "juice" }, { baseUnit: "l", currency: "EUR", businessDate: stockCount.businessDate });
  fireEvent.click(apply); expect(screen.getByLabelText("Unit cost Orange juice")).toHaveValue(2.666667); fireEvent.click(screen.getByRole("button", { name: "Save Counts" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("hotel-a", "count", "store", [{ catalogProductId: "juice", quantity: 12.5, unitCost: 2.666667, isCounted: true }], "counter", 0));
});
it("keeps unknown costs explicit and direct finishing available after a cost lookup failure", async () => {
  mocks.proposal.mockRejectedValueOnce(new Error("Recorded receipt evidence needs reconciliation")); render(show()); openValuation();
  fireEvent.change(screen.getByLabelText("Count Orange juice"), { target: { value: "0" } }); fireEvent.click(screen.getByRole("button", { name: "Suggest unit cost for Orange juice" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Recorded receipt evidence needs reconciliation"); expect(screen.getByLabelText("Unit cost Orange juice")).toHaveValue(null);
  fireEvent.click(screen.getByRole("button", { name: "Finish Location" })); await waitFor(() => expect(mocks.finish).toHaveBeenCalledWith("hotel-a", "count", "store", [{ catalogProductId: "juice", quantity: 0, unitCost: null, isCounted: true }], [], "counter", 0));
});
it("invalidates a reviewed automatic cost after frozen date or revision changes while retaining an explicit manual escape", async () => {
  const view = render(show()); openValuation(); fireEvent.click(screen.getByRole("button", { name: "Suggest unit cost for Orange juice" })); fireEvent.click(await screen.findByRole("button", { name: "Apply cost estimate for Orange juice" }));
  view.rerender(show({ ...stockCount, revision: 6, businessDate: "2026-10-11" }));
  expect(screen.getByText(/This applied estimate is stale/)).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Save Counts" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Unit cost Orange juice"), { target: { value: "3" } }); expect(screen.queryByText(/This applied estimate is stale/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save Counts" })).not.toBeDisabled();
});
it("does not send a draft under a replacement Auth object before React rerenders", () => {
  render(show()); fireEvent.change(screen.getByLabelText("Count Orange juice"), { target: { value: "1" } }); mocks.auth.currentUser = { uid: "another-counter" };
  fireEvent.click(screen.getByRole("button", { name: "Save Counts" })); expect(mocks.save).not.toHaveBeenCalled(); expect(screen.getByRole("alert")).toHaveTextContent(/signed-in user changed/);
});
it("does not offer weighted-cost actions for immutable finished counts", () => {
  render(show({ ...stockCount, status: "Finished" })); expect(screen.queryByRole("button", { name: "Suggest unit cost for Orange juice" })).not.toBeInTheDocument(); expect(mocks.proposal).not.toHaveBeenCalled();
});
