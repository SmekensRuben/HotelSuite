import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ hotelUid: "hotel-a", actor: { uid: "manager" }, rights: new Set(), load: vi.fn(), save: vi.fn(), pending: vi.fn(), retry: vi.fn() }));
vi.mock("../../firebaseConfig", () => ({ auth: { get currentUser() { return mocks.actor; } }, signOut: vi.fn() }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotelUid, permissions: [...mocks.rights], subscriptionActive: true }) }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: (feature, action) => mocks.rights.has(`${feature}.${action}`) }));
vi.mock("../../services/firebasePurchaseRequests", () => ({ getPurchaseBudgets: mocks.load, savePurchaseBudgets: mocks.save, getPendingPurchaseBudgetCommand: mocks.pending, retryPurchaseBudgetCommand: mocks.retry }));
vi.mock("../layout/HeaderBar", () => ({ default: () => <header>Hotel Toolkit</header> }));
import PurchaseBudgetsPage from "./PurchaseBudgetsPage";

const year = new Date().getFullYear();
const budgets = [{ id: "jan-maintenance", month: `${year}-01`, categoryId: "maintenance", budgetMinor: 50000, openingUsedMinor: 0, pendingMinor: 15000, committedMinor: 30000, remainingMinor: 5000, revision: 4 }];
const response = { year, currency: "EUR", vatBasis: "net", budgetCategories: [{ id: "maintenance", name: "Maintenance" }], costCentres: [{ id: "rooms", name: "Rooms" }], budgets };
beforeEach(() => {
  vi.clearAllMocks(); mocks.hotelUid = "hotel-a"; mocks.actor = { uid: "manager" }; mocks.rights = new Set(["purchasebudgets.read", "purchasebudgets.update", "purchasebudgets.settings"]);
  mocks.load.mockResolvedValue(response); mocks.save.mockResolvedValue({}); mocks.pending.mockReturnValue(null); mocks.retry.mockResolvedValue({});
});
const show = () => render(<MemoryRouter><PurchaseBudgetsPage /></MemoryRouter>);

it("keeps unconfigured months distinct from explicit zero budgets and saves reviewed revisions", async () => {
  show(); await waitFor(() => expect(screen.getByLabelText("January allocation")).toHaveValue("500.00"));
  expect(screen.getByLabelText("February allocation")).toHaveValue("");
  fireEvent.change(screen.getByLabelText("January opening consumption"), { target: { value: "50.29" } });
  fireEvent.change(screen.getByLabelText("February allocation"), { target: { value: "0.00" } });
  expect(screen.getByLabelText("Budget year")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Save budget changes" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("hotel-a", { budgets: [
    { month: `${year}-01`, categoryId: "maintenance", budgetMinor: 50000, openingUsedMinor: 5029, expectedRevision: 4 },
    { month: `${year}-02`, categoryId: "maintenance", budgetMinor: 0, openingUsedMinor: 0, expectedRevision: 0 },
  ] }));
});
it("copies only allocations to selected months without duplicating opening consumption", async () => {
  show(); await waitFor(() => expect(screen.getByLabelText("January allocation")).toHaveValue("500.00"));
  fireEvent.change(screen.getByLabelText("January opening consumption"), { target: { value: "75.00" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply allocation to selected months" }));
  expect(screen.getByLabelText("February allocation")).toHaveValue("500.00");
  expect(screen.getByLabelText("February opening consumption")).toHaveValue("");
  expect(screen.getByLabelText("January opening consumption")).toHaveValue("75.00");
  fireEvent.click(screen.getByRole("button", { name: "Save budget changes" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalled());
  expect(mocks.save.mock.calls[0][1].budgets).toHaveLength(12);
});
it("copies a previous year's allocations while retaining target-year commitments and opening consumption", async () => {
  mocks.load.mockImplementation((_hotel, requestedYear) => Promise.resolve(requestedYear === year ? response : { ...response, year: year - 1, budgets: [{ ...budgets[0], month: `${year - 1}-01`, budgetMinor: 80000, openingUsedMinor: 20000 }] }));
  show(); await waitFor(() => expect(screen.getByLabelText("January allocation")).toHaveValue("500.00"));
  fireEvent.change(screen.getByLabelText("January opening consumption"), { target: { value: "80.00" } });
  fireEvent.click(screen.getByRole("button", { name: "Copy year allocations" }));
  await waitFor(() => expect(screen.getByLabelText("January allocation")).toHaveValue("800.00"));
  expect(screen.getByLabelText("January opening consumption")).toHaveValue("80.00");
  expect(screen.getByText(/Opening consumption and commitments were not copied/)).toBeInTheDocument();
});
it("recovers the original hotel-wide save before permitting another year's edits", async () => {
  mocks.pending.mockReturnValue({ requestId: "original" }); show();
  await screen.findByLabelText("January allocation");
  expect(screen.getByLabelText("January allocation")).toBeDisabled();
  expect(screen.getByLabelText("Budget year")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Verify original budget save" }));
  await waitFor(() => expect(mocks.retry).toHaveBeenCalledWith("hotel-a"));
  expect(mocks.save).not.toHaveBeenCalled();
});
it("allows budget readers to see allocations without exposing configuration or enabling edits", async () => {
  mocks.rights = new Set(["purchasebudgets.read"]); show();
  await screen.findByLabelText("January allocation");
  expect(screen.getByLabelText("January allocation")).toBeDisabled();
  expect(screen.queryByRole("link", { name: "Approval and category settings" })).not.toBeInTheDocument();
  expect(screen.queryByText("Copy allocations")).not.toBeInTheDocument();
});
it("does not fetch budgets without the hotel budget read permission", () => {
  mocks.rights = new Set(["purchasebudgets.update"]); show(); expect(mocks.load).not.toHaveBeenCalled();
});
it("makes a revision conflict recoverable by explicitly reloading current ledger values", async () => {
  mocks.save.mockRejectedValue(new Error("The budget changed. Reload before saving."));
  show(); await waitFor(() => expect(screen.getByLabelText("January allocation")).toHaveValue("500.00"));
  fireEvent.change(screen.getByLabelText("January allocation"), { target: { value: "700.00" } });
  fireEvent.click(screen.getByRole("button", { name: "Save budget changes" }));
  await screen.findByText("The budget changed. Reload before saving.");
  expect(screen.getByLabelText("January allocation")).toHaveValue("700.00");
  mocks.load.mockResolvedValue({ ...response, budgets: [{ ...budgets[0], budgetMinor: 60000, revision: 5 }] });
  fireEvent.click(screen.getByRole("button", { name: "Reload saved budgets and discard draft changes" }));
  await waitFor(() => expect(screen.getByLabelText("January allocation")).toHaveValue("600.00"));
  expect(screen.getByLabelText("Budget year")).not.toBeDisabled();
});
it("ignores the old hotel's late budget response when switching properties", async () => {
  let resolveOld; mocks.load.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
  const view = show(); await waitFor(() => expect(mocks.load).toHaveBeenCalled());
  mocks.hotelUid = "hotel-b";
  mocks.load.mockResolvedValue({ ...response, budgetCategories: [{ id: "maintenance", name: "New hotel maintenance" }], budgets: [{ ...budgets[0], budgetMinor: 90000 }] });
  view.rerender(<MemoryRouter><PurchaseBudgetsPage /></MemoryRouter>);
  await waitFor(() => expect(screen.getByLabelText("January allocation")).toHaveValue("900.00"));
  await act(async () => resolveOld(response));
  expect(screen.getByLabelText("January allocation")).toHaveValue("900.00");
  expect(screen.getByRole("heading", { name: `New hotel maintenance · ${year}` })).toBeInTheDocument();
});
