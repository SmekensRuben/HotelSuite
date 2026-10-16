// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ packages: vi.fn(), save: vi.fn(), finish: vi.fn(), catalog: vi.fn() }));
vi.mock("../../firebaseConfig", () => ({ auth: { currentUser: { uid: "counter" } } }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: (feature, action) => feature === "stockcounts" && ["read", "update"].includes(action) }));
vi.mock("../../services/firebaseProducts", () => ({ getCatalogProducts: mocks.catalog }));
vi.mock("../../services/firebaseStockCounts", () => ({ getStockCountById: vi.fn(), getPendingStockCountMutation: () => null, retryPendingStockCountMutation: vi.fn(), getStockCountPackageOptions: mocks.packages, updateStockCountLocationCounts: mocks.save, finishStockCountLocation: mocks.finish, getStockCountProductChoices: vi.fn() }));
import CatalogStockCountLocationPanel from "./CatalogStockCountLocationPanel";
const location = { locationId: "store", locationName: "Main store", status: "In Progress", stockTemplate: { items: [{ catalogProductId: "juice", catalogProductName: "Orange juice", baseUnit: "l" }] },
  countedItems: [{ catalogProductId: "juice", catalogProductName: "Orange juice", baseUnit: "l", quantity: 1, unitCost: 2, isCounted: true }] };
const stockCount = { id: "count", status: "In Progress", currency: "EUR", businessDate: "2026-10-12", revision: 5 };
beforeEach(() => { localStorage.clear();
  mocks.save.mockReset(); mocks.finish.mockReset(); mocks.catalog.mockReset(); mocks.packages.mockReset(); mocks.save.mockResolvedValue({ revision: 6 });
  mocks.packages.mockResolvedValue({ options: [{ id: '["case","default"]', supplierProductId: "case", purchaseOptionId: "default", supplierProductName: "Orange juice", supplierName: "Vendor", purchaseUnit: "Case", baseUnit: "l", catalogUnitsPerPackage: 6 }], unavailable: [], nextCursor: null });
});
afterEach(cleanup);
const show = (patch = {}) => render(<MemoryRouter><CatalogStockCountLocationPanel hotelUid="hotel-a" stockCount={stockCount} location={{ ...location, ...patch }} /></MemoryRouter>);
it("normal stock counters apply packages without directory rights, preserve optional cost and save canonical quantity only", async () => {
  show(); expect(mocks.catalog).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Count packages and loose contents" }));
  fireEvent.focus(await screen.findByRole("combobox", { name: "Validated package 1" }));
  fireEvent.click(screen.getByRole("option", { name: "Orange juice · Vendor · Case (6 l)" }));
  fireEvent.change(screen.getByLabelText("Full packages 1"), { target: { value: "2" } });
  fireEvent.change(screen.getByLabelText("Loose quantity (l)"), { target: { value: "0.5" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply total to count" }));
  expect(screen.getByLabelText("Count Orange juice")).toHaveValue(12.5); expect(screen.getByLabelText("Unit cost Orange juice")).toHaveValue(2);
  fireEvent.click(screen.getByRole("button", { name: "Save Counts" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("hotel-a", "count", "store", [{ catalogProductId: "juice", quantity: 12.5, unitCost: 2, isCounted: true }], "counter", 0));
  expect(mocks.catalog).not.toHaveBeenCalled();
});
it("package lookup failure never disables direct counting or fills an unknown valuation", async () => {
  mocks.packages.mockRejectedValue(new Error("Package choices unavailable")); show({ countedItems: [] });
  fireEvent.click(screen.getByRole("button", { name: "Count packages and loose contents" })); await screen.findByText("Package choices unavailable");
  fireEvent.change(screen.getByLabelText("Count Orange juice"), { target: { value: "0" } });
  fireEvent.click(screen.getByRole("button", { name: "Finish Location" }));
  await waitFor(() => expect(mocks.finish).toHaveBeenCalledWith("hotel-a", "count", "store", [{ catalogProductId: "juice", quantity: 0, unitCost: null, isCounted: true }], [], "counter", 0));
});
it("completed frozen counts expose only immutable catalog quantities", () => {
  show({ status: "Finished" }); expect(screen.queryByRole("button", { name: "Count packages and loose contents" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("Count Orange juice")).toBeDisabled(); expect(mocks.packages).not.toHaveBeenCalled();
});
