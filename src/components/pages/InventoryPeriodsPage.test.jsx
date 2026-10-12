import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import InventoryPeriodsPage from "./InventoryPeriodsPage";
const mocks = vi.hoisted(() => ({ hotel: "hotel-a", canRead: true, locations: vi.fn(), checkpoints: vi.fn(), report: vi.fn() }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotel }) }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: () => mocks.canRead }));
vi.mock("../../firebaseConfig", () => ({ auth: { currentUser: { uid: "counter" } }, signOut: vi.fn() }));
vi.mock("../layout/HeaderBar", () => ({ default: () => null }));
vi.mock("../../services/firebaseInventory", () => ({ getInventoryLocations: mocks.locations, getInventoryCheckpoints: mocks.checkpoints, getInventoryPeriod: mocks.report }));
const v2 = () => ({ inventoryPolicyVersion: 1, reportPolicyVersion: 2, opening: { stockCountId: "opening", businessDate: "2026-10-01" }, closing: { stockCountId: "closing", businessDate: "2026-10-12" }, recordedReceiptCount: 1, recordedManualAdjustmentCount: 4,
  currency: "EUR", currentlyComplete: true, postClosureIssues: [], coverage: { issues: [], quantityComplete: true, costComplete: false }, items: [{ catalogProductId: "juice", catalogProductName: "Orange juice", baseUnit: "l", openingQuantity: 10, netReceiptQuantity: 4, transferInQuantity: 1, transferOutQuantity: 2, wasteQuantity: 1, breakageQuantity: 0, physicalReturnQuantity: 1, closingQuantity: 3, residualQuantity: 8, openingValue: null, receiptValue: 20, transferInValue: null, transferOutValue: null, wasteValue: null, breakageValue: 0, physicalReturnValue: null, closingValue: null, residualValue: null }] });
beforeEach(() => {
  vi.clearAllMocks(); mocks.hotel = "hotel-a"; mocks.canRead = true;
  mocks.locations.mockResolvedValue([{ locationId: "store", name: "Storeroom" }]);
  mocks.checkpoints.mockResolvedValue([{ stockCountId: "opening", stockCountName: "Opening count", businessDate: "2026-10-01", sequence: 1 }, { stockCountId: "closing", stockCountName: "Closing count", businessDate: "2026-10-12", sequence: 9 }]);
  mocks.report.mockImplementation(async (_hotel, _location, _opening, _closing, version) => version === 2 ? v2() : { ...v2(), reportPolicyVersion: 1, items: [{ catalogProductId: "juice", catalogProductName: "Orange juice", baseUnit: "l", openingQuantity: 10, netReceiptQuantity: 4, closingQuantity: 3, inferredUsageQuantity: 11, periodUnitCost: 2, inferredUsageValue: 22 }] });
});
async function choose(name, option) { fireEvent.focus(await screen.findByRole("combobox", { name })); const choice = await screen.findByRole("option", { name: option }); await act(async () => { fireEvent.click(choice); await Promise.resolve(); }); }
async function selectCounts() { await choose("Physical location", "Storeroom"); await choose("Opening count", "Opening count · 2026-10-01 · #1"); await choose("Closing count", "Closing count · 2026-10-12 · #9"); }
it("explicitly requests V2 classification and displays unknown source cost without invented consumption or value", async () => {
  render(<InventoryPeriodsPage />); await selectCounts();
  fireEvent.click(screen.getByRole("button", { name: "Compare counts" }));
  await waitFor(() => expect(mocks.report).toHaveBeenCalledWith("hotel-a", "store", "opening", "closing", 2));
  expect(await screen.findByRole("table", { name: "Classified period quantities" })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Registered waste" })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Residual difference" })).toBeInTheDocument();
  expect(screen.queryByRole("columnheader", { name: "Estimated cost / unit" })).not.toBeInTheDocument();
  expect(screen.getByText(/not guaranteed sales consumption/)).toBeInTheDocument();
  expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
});
it("retrieves historical V1 separately without rewriting it when V2 is selected", async () => {
  render(<InventoryPeriodsPage />); await selectCounts();
  fireEvent.change(screen.getByRole("combobox", { name: "Analysis policy" }), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "Compare counts" }));
  expect(await screen.findByRole("table", { name: "Original receipts-only quantities" })).toBeInTheDocument();
  expect(mocks.report).toHaveBeenLastCalledWith("hotel-a", "store", "opening", "closing", 1);
  fireEvent.change(screen.getByRole("combobox", { name: "Analysis policy" }), { target: { value: "2" } });
  expect(screen.queryByRole("table", { name: "Original receipts-only quantities" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Compare counts" }));
  expect(await screen.findByRole("table", { name: "Classified period quantities" })).toBeInTheDocument();
  expect(mocks.report).toHaveBeenCalledTimes(2);
});
it("keeps late-cutoff warnings explicit and suppresses current residual monetary advice", async () => {
  mocks.report.mockResolvedValue({ ...v2(), currentlyComplete: false, postClosureIssues: [{ code: "late-posting-after-closing", detail: "Late supplier return" }], items: [{ ...v2().items[0], residualValue: 300 }] });
  render(<InventoryPeriodsPage />); await selectCounts(); fireEvent.click(screen.getByRole("button", { name: "Compare counts" }));
  expect(await screen.findByText("Entries posted after this period closed")).toBeInTheDocument();
  expect(screen.getByText("Late supplier return")).toBeInTheDocument();
  expect(screen.queryByText(/300\.00/)).not.toBeInTheDocument();
});
it("does not reveal a late report after the hotel changes or read permission expires", async () => {
  let resolve; mocks.report.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const view = render(<InventoryPeriodsPage />); await selectCounts(); fireEvent.click(screen.getByRole("button", { name: "Compare counts" }));
  await waitFor(() => expect(mocks.report).toHaveBeenCalledTimes(1));
  mocks.hotel = "hotel-b"; mocks.canRead = false; view.rerender(<InventoryPeriodsPage />);
  await act(async () => resolve(v2()));
  expect(screen.queryByRole("table", { name: "Classified period quantities" })).not.toBeInTheDocument();
  expect(screen.getByText("Stock count read permission is required.")).toBeInTheDocument();
});
