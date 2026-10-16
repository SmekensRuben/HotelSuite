import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import InventoryMovementsPage from "./InventoryMovementsPage";
const mocks = vi.hoisted(() => ({ hotel: "hotel-a", permissions: { read: true, create: true, reverse: false }, auth: { currentUser: { uid: "operator" } },
  history: vi.fn(), choices: vi.fn(), pending: vi.fn(), record: vi.fn(), reverse: vi.fn(), retry: vi.fn(), proposal: vi.fn(), countRead: true }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotel }) }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: (feature, action) => feature === "stockcounts" ? mocks.countRead : mocks.permissions[action] === true }));
vi.mock("../../hooks/useStaffDisplayNames", () => ({ useStaffDisplayNames: () => ({ createdByName: "Jamie Hoteluser" }) }));
vi.mock("../../firebaseConfig", () => ({ auth: mocks.auth, signOut: vi.fn() }));
vi.mock("../layout/HeaderBar", () => ({ default: () => null }));
vi.mock("../../services/firebaseInventoryAdjustments", () => ({ getInventoryAdjustments: mocks.history, getInventoryAdjustmentChoices: mocks.choices,
  getPendingInventoryAdjustment: mocks.pending, recordInventoryAdjustment: mocks.record, reverseInventoryAdjustment: mocks.reverse, retryPendingInventoryAdjustment: mocks.retry }));
vi.mock("../../services/firebaseInventoryCostProposals", () => ({ getInventoryCostProposal: mocks.proposal }));
const costProposal = { hotelUid: "hotel-a", purpose: "movement", locationId: "store", catalogProductId: "juice", stockCountId: null, businessDate: "2026-10-12", costProposalPolicyVersion: 1,
  available: true, netUnitCost: 2.666667, baseUnit: "l", currency: "EUR", asOfMillis: 1791800000000, source: { anchorStockCountId: "opening", anchorCheckpointId: "cp1", openingBusinessDate: "2026-10-01", openingQuantity: 10, openingNetValue: 20,
    recordedMovementQuantity: 20, recordedMovementNetValue: 60, weightedSourceQuantity: 30, weightedSourceNetValue: 80, postingCutoffSequence: 3, movementCount: 2 }, reasons: [], costBasis: "Recorded source estimate, not live valuation." };
const event = (hotel = "hotel-a") => ({ adjustmentId: "movement-1", kind: "waste", reasonType: "breakage", catalogProductId: "juice", catalogProductName: hotel === "hotel-a" ? "Orange juice" : "Other hotel coffee", baseUnit: "l", quantity: 0.5,
  sourceLocationId: "store", sourceLocationName: "Storeroom", destinationLocationId: null, netUnitCost: null, netValue: null, currency: null, actorUid: "operator", postedAtMillis: 1234, businessDate: "2026-10-12", reference: "WASTE-1", note: "Bottle broke", reversedByAdjustmentId: null });
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
beforeEach(() => {
  window.history.replaceState({}, "", "/");
  vi.clearAllMocks(); mocks.hotel = "hotel-a"; mocks.auth.currentUser = { uid: "operator" }; mocks.permissions = { read: true, create: true, reverse: false }; mocks.countRead = true;
  mocks.proposal.mockResolvedValue(costProposal);
  mocks.pending.mockReturnValue(null); mocks.record.mockResolvedValue({}); mocks.reverse.mockResolvedValue({}); mocks.retry.mockResolvedValue({});
  mocks.history.mockImplementation(async (hotelUid) => ({ hotelUid, adjustments: [event(hotelUid)], nextCursor: null }));
  mocks.choices.mockImplementation(async (hotelUid, kind) => ({ hotelUid, kind, hotelCurrency: "EUR", choices: kind === "catalogproducts" ? [{ id: "juice", name: "Orange juice", baseUnit: "l" }] : [{ id: "store", name: "Storeroom" }, { id: "bar", name: "Lobby bar" }], nextCursor: null }));
});
async function choose(name, option) { const input = await screen.findByRole("combobox", { name }); fireEvent.focus(input); fireEvent.click(await screen.findByRole("option", { name: option })); }
async function prepareTransfer() {
  await choose("Catalog article", "Orange juice · l"); await choose("From stock point", "Storeroom"); await choose("To stock point", "Lobby bar");
  fireEvent.change(screen.getByRole("spinbutton", { name: "Movement quantity" }), { target: { value: "12.5" } });
  fireEvent.change(screen.getByLabelText("Business date"), { target: { value: "2026-10-12" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Reference" }), { target: { value: "TRANSFER-7" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Reason / evidence" }), { target: { value: "Moved bottles to lobby bar" } });
}
it("loads article and location choices automatically and shows immutable history separately", async () => {
  render(<InventoryMovementsPage />);
  expect(await screen.findByText("Breakage · Orange juice")).toBeInTheDocument();
  expect(screen.getByText(/Jamie Hoteluser/)).toBeInTheDocument();
  await waitFor(() => expect(mocks.choices).toHaveBeenCalledTimes(2));
  expect(mocks.choices).toHaveBeenCalledWith("hotel-a", "catalogproducts", null, "");
  expect(mocks.choices).toHaveBeenCalledWith("hotel-a", "locations", null, "");
  expect(screen.getByRole("form", { name: "Record a physical event" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Load movement sources" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Reverse this event" })).not.toBeInTheDocument();
  expect(screen.getByText(/do not create a live on-hand balance/)).toBeInTheDocument();
});
it("opens the precise exception event in existing history and keeps reversal audit links", async () => {
  window.history.replaceState({}, "", "/catalog/inventory-movements?hotelUid=hotel-a&eventId=movement-1");
  mocks.history.mockResolvedValue({ hotelUid: "hotel-a", adjustments: [{ ...event(), reversedByAdjustmentId: "reversal-1" }], nextCursor: null });
  render(<InventoryMovementsPage />); await screen.findByText("Breakage · Orange juice");
  expect(mocks.history).toHaveBeenCalledWith("hotel-a", null, "movement-1");
  expect(screen.getByRole("link", { name: "Review compensating reversal (new tab)" })).toHaveAttribute("href", "?hotelUid=hotel-a&eventId=reversal-1");
  expect(screen.queryByRole("button", { name: "Reverse this event" })).not.toBeInTheDocument();
});
it("shows article and location loading immediately without a technical load button", async () => {
  const waiting = deferred(); mocks.choices.mockReturnValue(waiting.promise);
  render(<InventoryMovementsPage />);
  expect(screen.getByText("Loading articles and locations…")).toHaveAttribute("role", "status");
  expect(screen.getByRole("combobox", { name: "Catalog article" })).toHaveAttribute("aria-busy", "true");
  expect(screen.getByRole("button", { name: "Record movement" })).toBeDisabled();
  expect(await screen.findByText("Breakage · Orange juice")).toBeInTheDocument();
});
it("does not request create-only article or location choices for a read-only movement user", async () => {
  mocks.permissions.create = false;
  render(<InventoryMovementsPage />);
  expect(await screen.findByText("Breakage · Orange juice")).toBeInTheDocument();
  expect(screen.queryByRole("form", { name: "Record a physical event" })).not.toBeInTheDocument();
  expect(mocks.choices).not.toHaveBeenCalled();
});
it("offers a clear retry after article lookup fails and keeps recording disabled until reviewed choices load", async () => {
  let failed = false;
  mocks.choices.mockImplementation(async (hotelUid, kind) => {
    if (kind === "catalogproducts" && !failed) { failed = true; throw new Error("Hotel access could not be verified."); }
    return { hotelUid, kind, hotelCurrency: "EUR", choices: kind === "catalogproducts" ? [{ id: "juice", name: "Orange juice", baseUnit: "l" }] : [{ id: "store", name: "Storeroom" }, { id: "bar", name: "Lobby bar" }], nextCursor: null };
  });
  render(<InventoryMovementsPage />);
  expect(await screen.findByText(/Articles or locations could not be loaded/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Record movement" })).toBeDisabled();
  expect(screen.getByRole("spinbutton", { name: "Estimated net unit cost" })).toHaveValue(null);
  fireEvent.click(screen.getByRole("button", { name: "Retry articles and locations" }));
  await choose("Catalog article", "Orange juice · l");
  expect(screen.queryByText(/Articles or locations could not be loaded/)).not.toBeInTheDocument();
  expect(screen.getByRole("spinbutton", { name: "Estimated net unit cost" })).toHaveValue(null);
});
it("explains why selecting an article keeps stock cost unknown instead of fabricating a supplier valuation", async () => {
  render(<InventoryMovementsPage />); await prepareTransfer();
  const cost = screen.getByRole("spinbutton", { name: "Estimated net unit cost" });
  expect(cost).toHaveValue(null);
  expect(cost).toHaveAttribute("placeholder", "Unknown — optional");
  expect(cost.closest("label")).toHaveTextContent("Estimated net cost per l (EUR) · Optional");
  expect(cost).toHaveAccessibleDescription(/A catalog article may have several supplier prices/);
  expect(cost).toHaveAccessibleDescription(/quantity is still recorded and its value remains unavailable/);
  expect(cost).not.toBeRequired();
  fireEvent.click(screen.getByRole("button", { name: "Record movement" }));
  await waitFor(() => expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ quantity: 12.5, netUnitCost: null, currency: null })));
});
it("clears a previous article's quantity and estimate when another article is selected", async () => {
  mocks.choices.mockImplementation(async (hotelUid, kind) => ({ hotelUid, kind, hotelCurrency: "EUR", choices: kind === "catalogproducts"
    ? [{ id: "juice", name: "Orange juice", baseUnit: "l" }, { id: "flour", name: "Flour", baseUnit: "kg" }]
    : [{ id: "store", name: "Storeroom" }, { id: "bar", name: "Lobby bar" }], nextCursor: null }));
  render(<InventoryMovementsPage />); await prepareTransfer();
  fireEvent.change(screen.getByRole("spinbutton", { name: "Estimated net unit cost" }), { target: { value: "5" } });
  await choose("Catalog article", "Flour · kg");
  expect(screen.getByRole("spinbutton", { name: "Movement quantity" })).toHaveValue(null);
  expect(screen.getByRole("spinbutton", { name: "Estimated net unit cost" })).toHaveValue(null);
  expect(screen.getByRole("spinbutton", { name: "Estimated net unit cost" }).closest("label")).toHaveTextContent("per kg (EUR) · Optional");
});
it("records a distinct-location transfer in canonical units and keeps unknown cost explicit", async () => {
  render(<InventoryMovementsPage />); await prepareTransfer();
  fireEvent.click(screen.getByRole("button", { name: "Record movement" }));
  await waitFor(() => expect(mocks.record).toHaveBeenCalledWith({ hotelUid: "hotel-a", kind: "transfer", catalogProductId: "juice", quantity: 12.5,
    sourceLocationId: "store", destinationLocationId: "bar", businessDate: "2026-10-12", reference: "TRANSFER-7", note: "Moved bottles to lobby bar", netUnitCost: null, currency: null }));
  expect(await screen.findByText(/Movement evidence recorded/)).toBeInTheDocument();
});
it("records an explicit zero estimate in its selected hotel currency", async () => {
  render(<InventoryMovementsPage />); await prepareTransfer();
  fireEvent.change(screen.getByRole("spinbutton", { name: "Estimated net unit cost" }), { target: { value: "0" } });
  fireEvent.click(screen.getByRole("button", { name: "Record movement" }));
  await waitFor(() => expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ netUnitCost: 0, currency: "EUR" })));
});
it("does not reinterpret an entered estimate when a refreshed source reports another currency", async () => {
  render(<InventoryMovementsPage />); await prepareTransfer();
  fireEvent.change(screen.getByRole("spinbutton", { name: "Estimated net unit cost" }), { target: { value: "5" } });
  mocks.choices.mockImplementation(async (hotelUid, kind) => ({ hotelUid, kind, hotelCurrency: "USD", choices: kind === "locations" ? [{ id: "store", name: "Storeroom" }, { id: "bar", name: "Lobby bar" }] : [{ id: "juice", name: "Orange juice", baseUnit: "l" }], nextCursor: null }));
  fireEvent.change(screen.getByRole("combobox", { name: "To stock point" }), { target: { value: "Lobby" } });
  await waitFor(() => expect(mocks.choices).toHaveBeenCalledWith("hotel-a", "locations", null, "lobby"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Record movement" })).not.toBeDisabled());
  expect(screen.getByRole("spinbutton", { name: "Estimated net unit cost" }).closest("label")).toHaveTextContent("(EUR)");
  fireEvent.click(screen.getByRole("button", { name: "Record movement" }));
  expect(await screen.findByText(/explicit currency no longer matches/)).toBeInTheDocument();
  expect(mocks.record).not.toHaveBeenCalled();
});
it("shows ordinary progress during submission and reconciliation only after an uncertain response", async () => {
  const waiting = deferred(); mocks.record.mockReturnValueOnce(waiting.promise);
  render(<InventoryMovementsPage />); await prepareTransfer();
  fireEvent.click(screen.getByRole("button", { name: "Record movement" }));
  expect(await screen.findByRole("status", { name: "" })).toHaveTextContent("Recording movement evidence");
  expect(screen.queryByText("A saved movement request needs reconciliation")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Record movement" })).toBeDisabled();
  mocks.pending.mockReturnValue({ operation: "record", input: { quantity: 12.5 }, requestId: "original-id" });
  await act(async () => waiting.reject(new Error("Response lost")));
  expect(await screen.findByText("A saved movement request needs reconciliation")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry saved movement request" }));
  await waitFor(() => expect(mocks.retry).toHaveBeenCalledWith("hotel-a"));
  expect(mocks.record).toHaveBeenCalledTimes(1);
});
it("restores an exact pending request after remount and prevents a replacement operation", async () => {
  mocks.pending.mockReturnValue({ operation: "record", input: { quantity: 4 }, requestId: "original-id" });
  render(<InventoryMovementsPage />);
  expect(await screen.findByText("A saved movement request needs reconciliation")).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Catalog article" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Retry saved movement request" }));
  await waitFor(() => expect(mocks.retry).toHaveBeenCalledWith("hotel-a"));
  expect(mocks.record).not.toHaveBeenCalled();
});
it("uses a separate reversal grant and offsets the original by identity without editable quantities", async () => {
  mocks.permissions = { read: true, create: false, reverse: true };
  render(<InventoryMovementsPage />);
  expect(screen.queryByRole("form", { name: "Record a physical event" })).not.toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: "Reverse this event" }));
  expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Reversal business date"), { target: { value: "2026-10-12" } });
  fireEvent.change(screen.getByLabelText("Reversal reference"), { target: { value: "FIX-7" } });
  fireEvent.change(screen.getByLabelText("Reversal reason"), { target: { value: "Recorded twice" } });
  fireEvent.click(screen.getByRole("button", { name: "Confirm compensating reversal" }));
  await waitFor(() => expect(mocks.reverse).toHaveBeenCalledWith({ hotelUid: "hotel-a", adjustmentId: "movement-1", businessDate: "2026-10-12", reference: "FIX-7", note: "Recorded twice" }));
});
it("ignores a late mutation response after switching hotel", async () => {
  const waiting = deferred(); mocks.record.mockReturnValueOnce(waiting.promise);
  const view = render(<InventoryMovementsPage />); await prepareTransfer();
  fireEvent.click(screen.getByRole("button", { name: "Record movement" }));
  await waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(1));
  mocks.hotel = "hotel-b"; view.rerender(<InventoryMovementsPage />);
  expect(await screen.findByText("Breakage · Other hotel coffee")).toBeInTheDocument();
  await act(async () => waiting.resolve({}));
  expect(screen.queryByText(/Movement evidence recorded/)).not.toBeInTheDocument();
  expect(screen.queryByText("Breakage · Orange juice")).not.toBeInTheDocument();
});
it("does not submit an old actor's form during an auth change before React rerenders", async () => {
  render(<InventoryMovementsPage />); await prepareTransfer();
  mocks.auth.currentUser = { uid: "another-operator" };
  fireEvent.click(screen.getByRole("button", { name: "Record movement" }));
  expect(mocks.record).not.toHaveBeenCalled();
});
it("blocks unavailable source projections and permits explicit load-more across empty scanned pages", async () => {
  mocks.choices.mockImplementation(async (hotelUid, kind, afterId) => ({ hotelUid, kind, hotelCurrency: null, choices: [], nextCursor: kind === "catalogproducts" && !afterId ? "scanned-50" : null }));
  render(<InventoryMovementsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Load more catalog articles" }));
  await waitFor(() => expect(mocks.choices).toHaveBeenCalledWith("hotel-a", "catalogproducts", "scanned-50", ""));
  expect(screen.getByRole("spinbutton", { name: "Estimated net unit cost" })).toBeDisabled();
  expect(screen.getByText("The hotel's currency is unavailable. You can record the quantity, but cannot enter a cost estimate.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Record movement" })).toBeDisabled();
});
it("does not send a reversal replay after the special permission is revoked", async () => {
  mocks.pending.mockReturnValue({ operation: "reverse", input: { adjustmentId: "movement-1" }, requestId: "original-id" });
  mocks.permissions = { read: true, create: true, reverse: false };
  render(<InventoryMovementsPage />);
  expect(await screen.findByRole("button", { name: "Retry saved movement request" })).toBeDisabled();
  expect(mocks.retry).not.toHaveBeenCalled();
});
it("sends the typed name prefix to the protected search and preserves it on the next scanned page", async () => {
  mocks.choices.mockImplementation(async (hotelUid, kind, afterId, query) => ({ hotelUid, kind, hotelCurrency: "EUR", choices: [], nextCursor: kind === "catalogproducts" && query === "orange" && !afterId ? "scanned-50" : null }));
  render(<InventoryMovementsPage />);
  const input = await screen.findByRole("combobox", { name: "Catalog article" });
  fireEvent.change(input, { target: { value: "Orange" } });
  await waitFor(() => expect(mocks.choices).toHaveBeenCalledWith("hotel-a", "catalogproducts", null, "orange"));
  const more = await screen.findByRole("button", { name: "Load more catalog articles" });
  await waitFor(() => expect(more).not.toBeDisabled()); fireEvent.click(more);
  await waitFor(() => expect(mocks.choices).toHaveBeenCalledWith("hotel-a", "catalogproducts", "scanned-50", "orange"));
});

it("requests a reviewed cost lazily, preserves typed manual cost, then freezes the explicitly applied number with a new movement", async () => {
  render(<InventoryMovementsPage />); await prepareTransfer();
  const cost = screen.getByRole("spinbutton", { name: "Estimated net unit cost" }); fireEvent.change(cost, { target: { value: "7" } });
  expect(mocks.proposal).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Suggest unit cost for Orange juice" }));
  const apply = await screen.findByRole("button", { name: "Apply cost estimate for Orange juice" }); expect(cost).toHaveValue(7);
  expect(mocks.proposal).toHaveBeenCalledWith({ hotelUid: "hotel-a", purpose: "movement", locationId: "store", catalogProductId: "juice", businessDate: "2026-10-12" }, { baseUnit: "l", currency: "EUR", businessDate: "2026-10-12" });
  fireEvent.click(apply); expect(cost).toHaveValue(2.666667);
  fireEvent.click(screen.getByRole("button", { name: "Record movement" }));
  await waitFor(() => expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ netUnitCost: 2.666667, currency: "EUR", quantity: 12.5 })));
  expect(mocks.record.mock.calls[0][0]).not.toHaveProperty("appliedEstimate");
});
it("blocks an applied suggestion after its date or physical source changes until explicitly reviewed", async () => {
  render(<InventoryMovementsPage />); await prepareTransfer();
  fireEvent.click(screen.getByRole("button", { name: "Suggest unit cost for Orange juice" })); fireEvent.click(await screen.findByRole("button", { name: "Apply cost estimate for Orange juice" }));
  fireEvent.change(screen.getByLabelText("Business date"), { target: { value: "2026-10-11" } });
  expect(screen.getByRole("button", { name: "Record movement" })).toBeDisabled(); expect(screen.getByText(/This applied estimate is stale/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Apply cost estimate for Orange juice" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Clear applied estimate" }));
  expect(screen.getByRole("spinbutton", { name: "Estimated net unit cost" })).toHaveValue(null); expect(screen.getByRole("button", { name: "Record movement" })).not.toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Suggest unit cost for Orange juice" })); fireEvent.click(await screen.findByRole("button", { name: "Apply cost estimate for Orange juice" }));
  await choose("From stock point", "Lobby bar");
  expect(screen.getByText(/This applied estimate is stale/)).toBeInTheDocument();
  fireEvent.change(screen.getByRole("spinbutton", { name: "Estimated net unit cost" }), { target: { value: "4" } });
  expect(screen.queryByText(/This applied estimate is stale/)).not.toBeInTheDocument();
});
it("does not fetch costs without count read access and still permits an unknown-cost physical event", async () => {
  mocks.countRead = false; render(<InventoryMovementsPage />); await prepareTransfer();
  expect(screen.queryByRole("button", { name: "Suggest unit cost for Orange juice" })).not.toBeInTheDocument();
  expect(screen.getByText(/Stock count read permission is required/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Record movement" }));
  await waitFor(() => expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ netUnitCost: null, currency: null })));
  expect(mocks.proposal).not.toHaveBeenCalled();
});
it("keeps quantities and manual recording usable when the weighted evidence is unavailable", async () => {
  mocks.proposal.mockResolvedValueOnce({ ...costProposal, available: false, netUnitCost: null, source: null, reasons: [{ code: "unknown", detail: "Opening valuation is unknown." }] });
  render(<InventoryMovementsPage />); await prepareTransfer(); fireEvent.click(screen.getByRole("button", { name: "Suggest unit cost for Orange juice" }));
  expect(await screen.findByText("Opening valuation is unknown.")).toBeInTheDocument(); expect(screen.getByRole("spinbutton", { name: "Estimated net unit cost" })).toHaveValue(null);
  expect(screen.getByRole("spinbutton", { name: "Movement quantity" })).toHaveValue(12.5); expect(screen.getByRole("button", { name: "Record movement" })).not.toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Record movement" }));
  await waitFor(() => expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ netUnitCost: null, currency: null })));
});

const stockPointChoices = [
  { id: "outlet:cellar", name: "Drinks cellar", stockPointType: "outlet", outletId: "cellar", outletName: "Drinks cellar", inventoryRole: "central_storage" },
  { id: "cellar-fridge", name: "Cold store", stockPointType: "location", outletId: "cellar", outletName: "Drinks cellar", inventoryRole: "central_storage" },
  { id: "outlet:lobby", name: "Lobby bar", stockPointType: "outlet", outletId: "lobby", outletName: "Lobby bar", inventoryRole: "outlet" },
  { id: "lobby-fridge", name: "Back-bar fridge", stockPointType: "location", outletId: "lobby", outletName: "Lobby bar", inventoryRole: "outlet" },
  { id: "outlet:restaurant", name: "Restaurant", stockPointType: "outlet", outletId: "restaurant", outletName: "Restaurant", inventoryRole: "outlet" },
];
function useStockPointChoices() {
  mocks.choices.mockImplementation(async (hotelUid, kind) => ({ hotelUid, kind, hotelCurrency: "EUR", today: "2026-10-12", choices: kind === "catalogproducts" ? [{ id: "juice", name: "Orange juice", baseUnit: "l" }] : stockPointChoices, nextCursor: null }));
}
it("requisitions central stock to another entire outlet with balanced transfer intent", async () => {
  useStockPointChoices(); render(<InventoryMovementsPage />);
  fireEvent.change(screen.getByRole("combobox", { name: "Event type" }), { target: { value: "requisition" } });
  await choose("From stock point", "Drinks cellar · Central stock point");
  await choose("To stock point", "Lobby bar · Entire outlet");
  await choose("Catalog article", "Orange juice · l");
  fireEvent.change(screen.getByRole("spinbutton", { name: "Movement quantity" }), { target: { value: "12" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Reference" }), { target: { value: "REQ-12" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Reason / evidence" }), { target: { value: "Restock lobby bar" } });
  expect(screen.getByLabelText("Business date")).toHaveValue("2026-10-12");
  fireEvent.click(screen.getByRole("button", { name: "Record requisition" }));
  await waitFor(() => expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ kind: "transfer", movementType: "requisition", sourceLocationId: "outlet:cellar", destinationLocationId: "outlet:lobby", quantity: 12 })));
  expect(await screen.findByText(/Movement evidence recorded/)).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "From stock point" })).toHaveValue("Drinks cellar · Central stock point");
  expect(screen.getByRole("combobox", { name: "To stock point" })).toHaveValue("Lobby bar · Entire outlet");
  expect(screen.getByRole("spinbutton", { name: "Movement quantity" })).toHaveValue(null);
});
it("reveals detailed stock locations only when explicitly requested", async () => {
  useStockPointChoices(); render(<InventoryMovementsPage />);
  fireEvent.change(screen.getByRole("combobox", { name: "Event type" }), { target: { value: "requisition" } });
  const source = screen.getByRole("combobox", { name: "From stock point" });
  fireEvent.focus(source);
  expect(await screen.findByRole("option", { name: "Drinks cellar · Central stock point" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /Cold store/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "Lobby bar · Entire outlet" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: "Use a detailed source location" }));
  await choose("From stock point", "Drinks cellar / Cold store · Location");
  fireEvent.focus(screen.getByRole("combobox", { name: "To stock point" }));
  expect(await screen.findByRole("option", { name: "Lobby bar · Entire outlet" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /Drinks cellar/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /Back-bar fridge/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: "Use a detailed destination location" }));
  await choose("To stock point", "Lobby bar / Back-bar fridge · Location");
  fireEvent.click(screen.getByRole("checkbox", { name: "Use a detailed destination location" }));
  expect(screen.getByRole("combobox", { name: "To stock point" })).toHaveValue("");
});
it("clears an ordinary outlet source when changing a transfer to a requisition", async () => {
  useStockPointChoices(); render(<InventoryMovementsPage />);
  await choose("From stock point", "Lobby bar · Entire outlet");
  fireEvent.change(screen.getByRole("combobox", { name: "Event type" }), { target: { value: "requisition" } });
  expect(screen.getByRole("combobox", { name: "From stock point" })).toHaveValue("");
  expect(screen.getByRole("combobox", { name: "To stock point" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Record requisition" })).toBeDisabled();
});
it("preserves requisition classification in immutable movement history", async () => {
  mocks.history.mockResolvedValue({ hotelUid: "hotel-a", adjustments: [{ ...event(), kind: "transfer", movementType: "requisition", sourceLocationName: "Drinks cellar", destinationLocationId: "outlet:lobby", destinationLocationName: "Lobby bar" }], nextCursor: null });
  render(<InventoryMovementsPage />);
  expect(await screen.findByText("Requisition · Orange juice")).toBeInTheDocument();
  expect(screen.getByText(/Drinks cellar → Lobby bar/)).toBeInTheDocument();
});
it("keeps a linked requisition source explicit until its verified later page is loaded", async () => {
  window.history.replaceState({}, "", "/catalog/inventory-movements?type=requisition&sourceOutletId=cellar");
  mocks.choices.mockImplementation(async (hotelUid, kind, afterId) => ({ hotelUid, kind, hotelCurrency: "EUR", choices: kind === "catalogproducts" ? [{ id: "juice", name: "Orange juice", baseUnit: "l" }]
    : afterId ? [stockPointChoices[0], stockPointChoices[2]] : [{ id: "outlet:backup", name: "Backup store", stockPointType: "outlet", outletId: "backup", inventoryRole: "central_storage" }], nextCursor: kind === "locations" && !afterId ? "outlet:backup" : null }));
  render(<InventoryMovementsPage />);
  expect(await screen.findByText(/The linked source has not been found/)).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "From stock point" })).toHaveValue("");
  expect(screen.getByRole("button", { name: "Record requisition" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Load more stock points" }));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "From stock point" })).toHaveValue("Drinks cellar · Central stock point"));
  expect(screen.queryByText(/The linked source has not been found/)).not.toBeInTheDocument();
});
