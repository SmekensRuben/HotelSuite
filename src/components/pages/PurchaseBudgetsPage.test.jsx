import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
const categories = [{ id: "maintenance", name: "Maintenance" }, { id: "chinaware", name: "Chinaware" }];
const response = { year, currency: "EUR", vatBasis: "net", budgetCategories: categories, costCentres: [{ id: "rooms", name: "Rooms" }], budgets };
beforeEach(() => {
  vi.clearAllMocks(); mocks.hotelUid = "hotel-a"; mocks.actor = { uid: "manager" }; mocks.rights = new Set(["purchasebudgets.read", "purchasebudgets.update", "purchasebudgets.settings"]);
  mocks.load.mockResolvedValue(response); mocks.save.mockResolvedValue({}); mocks.pending.mockReturnValue(null); mocks.retry.mockResolvedValue({});
});
const show = () => render(<MemoryRouter><PurchaseBudgetsPage /></MemoryRouter>);
const month = (value) => fireEvent.change(screen.getByLabelText("Budget month"), { target: { value } });
const categoryView = () => fireEvent.click(screen.getByRole("button", { name: "By category" }));
const summary = () => screen.getByRole("region", { name: "Budget summary" });
const metric = (label) => within(summary()).getByText(label).parentElement;
const money = (minor) => new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR" }).format(minor / 100);

it("opens the current month with every category and an explicitly scoped overview", async () => {
  show(); await screen.findByLabelText("Maintenance allocation");
  expect(screen.getByRole("button", { name: "By month" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByLabelText("Budget month")).toHaveValue(String(new Date().getMonth() + 1).padStart(2, "0"));
  expect(screen.getByLabelText("Chinaware allocation")).toBeInTheDocument();
  expect(screen.queryByLabelText("January allocation")).not.toBeInTheDocument();
  month("01");
  expect(screen.getByRole("heading", { name: `January ${year}` })).toBeInTheDocument();
  expect(within(summary()).getByText("1 of 2 categories configured")).toBeInTheDocument();
  expect(metric("Known allocations")).toHaveTextContent(money(50000));
  expect(metric("Total remaining")).toHaveTextContent("—");
  expect(metric("Pending requests")).toHaveTextContent(money(15000));
  expect(metric("Approved commitments")).toHaveTextContent(money(30000));
});

it("distinguishes missing allocations from explicit zero and updates totals from the draft", async () => {
  show(); await screen.findByLabelText("Maintenance allocation"); month("01");
  expect(screen.getByLabelText("Chinaware allocation")).toHaveValue("");
  fireEvent.change(screen.getByLabelText("Maintenance opening consumption"), { target: { value: "10.29" } });
  fireEvent.change(screen.getByLabelText("Chinaware allocation"), { target: { value: "0.00" } });
  expect(within(summary()).getByText("2 of 2 categories configured")).toBeInTheDocument();
  expect(metric("Total allocation")).toHaveTextContent(money(50000));
  expect(metric("Total remaining")).toHaveTextContent(money(3971));
  expect(within(summary()).getByText(/Includes unsaved changes/)).toBeInTheDocument();
  expect(screen.getByLabelText("Budget year")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Save budget changes" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("hotel-a", { budgets: [
    { month: `${year}-01`, categoryId: "maintenance", budgetMinor: 50000, openingUsedMinor: 1029, expectedRevision: 4 },
    { month: `${year}-01`, categoryId: "chinaware", budgetMinor: 0, openingUsedMinor: 0, expectedRevision: 0 },
  ] }));
});

it("preserves a single annual draft when navigating months, categories and views and saves all changed cells", async () => {
  show(); await screen.findByLabelText("Maintenance allocation"); month("01");
  fireEvent.change(screen.getByLabelText("Chinaware allocation"), { target: { value: "200.00" } });
  month("02");
  fireEvent.change(screen.getByLabelText("Maintenance allocation"), { target: { value: "300.00" } });
  categoryView();
  expect(screen.getByLabelText("January allocation")).toHaveValue("500.00");
  expect(screen.getByLabelText("February allocation")).toHaveValue("300.00");
  expect(screen.getByRole("heading", { name: `Maintenance · ${year}` })).toBeInTheDocument();
  expect(within(summary()).getByText("2 of 12 months configured")).toBeInTheDocument();
  expect(metric("Known allocations")).toHaveTextContent(money(80000));
  fireEvent.change(screen.getByLabelText("Budget category"), { target: { value: "chinaware" } });
  expect(screen.getByLabelText("January allocation")).toHaveValue("200.00");
  fireEvent.change(screen.getByLabelText("March allocation"), { target: { value: "400.00" } });
  fireEvent.click(screen.getByRole("button", { name: "By month" }));
  expect(screen.getByLabelText("Budget month")).toHaveValue("02");
  expect(metric("Known allocations")).toHaveTextContent(money(30000));
  month("01"); expect(screen.getByLabelText("Chinaware allocation")).toHaveValue("200.00");
  fireEvent.click(screen.getByRole("button", { name: "Save budget changes" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("hotel-a", { budgets: [
    { month: `${year}-01`, categoryId: "chinaware", budgetMinor: 20000, openingUsedMinor: 0, expectedRevision: 0 },
    { month: `${year}-02`, categoryId: "maintenance", budgetMinor: 30000, openingUsedMinor: 0, expectedRevision: 0 },
    { month: `${year}-03`, categoryId: "chinaware", budgetMinor: 40000, openingUsedMinor: 0, expectedRevision: 0 },
  ] }));
});

it("keeps invalid and cleared saved allocations unavailable and refuses to save them", async () => {
  show(); await screen.findByLabelText("Maintenance allocation"); month("01");
  fireEvent.change(screen.getByLabelText("Maintenance opening consumption"), { target: { value: "1.234" } });
  expect(screen.getByText("Check invalid amounts")).toBeInTheDocument();
  expect(metric("Opening consumption")).toHaveTextContent("—");
  expect(metric("Total remaining")).toHaveTextContent("—");
  fireEvent.click(screen.getByRole("button", { name: "Save budget changes" }));
  await screen.findByText("Enter a non-negative amount with no more than two decimal places.");
  expect(mocks.save).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Maintenance opening consumption"), { target: { value: "0" } });
  fireEvent.change(screen.getByLabelText("Maintenance allocation"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save budget changes" }));
  await screen.findByText("An existing allocation cannot be cleared. Enter 0 for an explicit zero budget.");
  expect(mocks.save).not.toHaveBeenCalled();
});

it("copies only the chosen category's allocations across months and preserves opening consumption", async () => {
  show(); await screen.findByLabelText("Maintenance allocation"); month("01");
  fireEvent.change(screen.getByLabelText("Maintenance opening consumption"), { target: { value: "75.00" } });
  fireEvent.change(screen.getByLabelText("Chinaware allocation"), { target: { value: "90.00" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply allocation to selected months" }));
  categoryView();
  expect(screen.getByLabelText("February allocation")).toHaveValue("500.00");
  expect(screen.getByLabelText("February opening consumption")).toHaveValue("");
  expect(screen.getByLabelText("January opening consumption")).toHaveValue("75.00");
  fireEvent.change(screen.getByLabelText("Budget category"), { target: { value: "chinaware" } });
  expect(screen.getByLabelText("January allocation")).toHaveValue("90.00");
  expect(screen.getByLabelText("February allocation")).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "Save budget changes" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalled());
  expect(mocks.save.mock.calls[0][1].budgets).toHaveLength(13);
});

it("copies a previous year's allocations while retaining target-year commitments and opening consumption", async () => {
  mocks.load.mockImplementation((_hotel, requestedYear) => Promise.resolve(requestedYear === year ? response : { ...response, year: year - 1, budgets: [{ ...budgets[0], month: `${year - 1}-01`, budgetMinor: 80000, openingUsedMinor: 20000 }] }));
  show(); await screen.findByLabelText("Maintenance allocation"); month("01");
  fireEvent.change(screen.getByLabelText("Maintenance opening consumption"), { target: { value: "80.00" } });
  fireEvent.click(screen.getByRole("button", { name: "Copy year allocations" }));
  await waitFor(() => expect(screen.getByLabelText("Maintenance allocation")).toHaveValue("800.00"));
  expect(screen.getByLabelText("Maintenance opening consumption")).toHaveValue("80.00");
  expect(metric("Pending requests")).toHaveTextContent(money(15000));
  expect(metric("Approved commitments")).toHaveTextContent(money(30000));
  expect(screen.getByText(/Opening consumption and commitments were not copied/)).toBeInTheDocument();
});

it("discards one category across the year while retaining another category's draft", async () => {
  show(); await screen.findByLabelText("Maintenance allocation"); month("01");
  fireEvent.change(screen.getByLabelText("Maintenance allocation"), { target: { value: "700.00" } });
  fireEvent.change(screen.getByLabelText("Chinaware allocation"), { target: { value: "90.00" } });
  categoryView();
  fireEvent.change(screen.getByLabelText("February allocation"), { target: { value: "800.00" } });
  fireEvent.click(screen.getByRole("button", { name: "Discard this category's changes" }));
  expect(screen.getByLabelText("January allocation")).toHaveValue("500.00");
  expect(screen.getByLabelText("February allocation")).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "By month" }));
  expect(screen.getByLabelText("Chinaware allocation")).toHaveValue("90.00");
  fireEvent.click(screen.getByRole("button", { name: "Discard all changes" }));
  expect(screen.getByLabelText("Chinaware allocation")).toHaveValue("");
  expect(screen.getByLabelText("Budget year")).not.toBeDisabled();
});

it("blocks an oversized annual save across categories and lets a category discard reduce it safely", async () => {
  const manyCategories = Array.from({ length: 22 }, (_, index) => ({ id: `category-${index}`, name: `Category ${index}` }));
  mocks.load.mockResolvedValue({ ...response, budgetCategories: manyCategories, budgets: manyCategories.map((category) => ({ ...budgets[0], categoryId: category.id })) });
  show(); await screen.findByLabelText("Category 0 allocation");
  for (const category of manyCategories) {
    fireEvent.change(screen.getByLabelText("Copy budget category"), { target: { value: category.id } });
    fireEvent.click(screen.getByRole("button", { name: "Apply allocation to selected months" }));
  }
  expect(screen.getByRole("button", { name: "Save budget changes" })).toBeDisabled();
  expect(screen.getByText(/242 changed monthly allocations/)).toBeInTheDocument();
  expect(mocks.save).not.toHaveBeenCalled();
  categoryView();
  fireEvent.click(screen.getByRole("button", { name: "Discard this category's changes" }));
  expect(screen.getByRole("button", { name: "Save budget changes" })).not.toBeDisabled();
  expect(screen.getByText(/231 changed monthly allocations/)).toBeInTheDocument();
  expect(screen.getByLabelText("February allocation")).toHaveValue("");
});

it("recovers the original hotel-wide save without allowing new edits in either view", async () => {
  mocks.pending.mockReturnValue({ requestId: "original" }); show();
  await screen.findByLabelText("Maintenance allocation");
  expect(screen.getByLabelText("Maintenance allocation")).toBeDisabled();
  expect(screen.getByLabelText("Budget year")).toBeDisabled();
  categoryView();
  expect(screen.getByLabelText("January allocation")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Verify original budget save" }));
  await waitFor(() => expect(mocks.retry).toHaveBeenCalledWith("hotel-a"));
  expect(mocks.save).not.toHaveBeenCalled();
});

it("retains uncertain save values for exact recovery even after switching views", async () => {
  mocks.save.mockImplementation(async () => { mocks.pending.mockReturnValue({ requestId: "uncertain" }); throw new Error("Connection lost. Verify the original save."); });
  show(); await screen.findByLabelText("Maintenance allocation"); month("01");
  fireEvent.change(screen.getByLabelText("Maintenance allocation"), { target: { value: "700.00" } });
  fireEvent.click(screen.getByRole("button", { name: "Save budget changes" }));
  await screen.findByText("Connection lost. Verify the original save.");
  categoryView();
  expect(screen.getByLabelText("January allocation")).toHaveValue("700.00");
  expect(screen.getByLabelText("January allocation")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Verify original budget save" }));
  await waitFor(() => expect(mocks.retry).toHaveBeenCalledWith("hotel-a"));
  expect(mocks.save).toHaveBeenCalledTimes(1);
});

it("allows budget readers to navigate both views without exposing configuration or editing", async () => {
  mocks.rights = new Set(["purchasebudgets.read"]); show();
  await screen.findByLabelText("Maintenance allocation");
  expect(screen.getByLabelText("Maintenance allocation")).toBeDisabled();
  expect(screen.queryByRole("link", { name: "Approval and category settings" })).not.toBeInTheDocument();
  expect(screen.queryByText("Copy allocations")).not.toBeInTheDocument();
  categoryView();
  expect(screen.getByLabelText("January allocation")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save budget changes" })).toBeDisabled();
});

it("does not fetch budgets without the hotel budget read permission", () => {
  mocks.rights = new Set(["purchasebudgets.update"]); show(); expect(mocks.load).not.toHaveBeenCalled();
});

it("makes a revision conflict recoverable by explicitly reloading current ledger values", async () => {
  mocks.save.mockRejectedValue(new Error("The budget changed. Reload before saving."));
  show(); await screen.findByLabelText("Maintenance allocation"); month("01");
  fireEvent.change(screen.getByLabelText("Maintenance allocation"), { target: { value: "700.00" } });
  fireEvent.click(screen.getByRole("button", { name: "Save budget changes" }));
  await screen.findByText("The budget changed. Reload before saving.");
  expect(screen.getByLabelText("Maintenance allocation")).toHaveValue("700.00");
  mocks.load.mockResolvedValue({ ...response, budgets: [{ ...budgets[0], budgetMinor: 60000, revision: 5 }] });
  fireEvent.click(screen.getByRole("button", { name: "Reload saved budgets and discard draft changes" }));
  await waitFor(() => expect(screen.getByLabelText("Maintenance allocation")).toHaveValue("600.00"));
  expect(screen.getByLabelText("Budget year")).not.toBeDisabled();
});

it("ignores the old hotel's late response and clears drafts when changing hotels", async () => {
  let resolveOld; mocks.load.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
  const view = show(); await waitFor(() => expect(mocks.load).toHaveBeenCalled());
  mocks.hotelUid = "hotel-b";
  mocks.load.mockResolvedValue({ ...response, budgetCategories: [{ id: "maintenance", name: "New hotel maintenance" }], budgets: [{ ...budgets[0], budgetMinor: 90000 }] });
  view.rerender(<MemoryRouter><PurchaseBudgetsPage /></MemoryRouter>);
  await screen.findByLabelText("New hotel maintenance allocation"); month("01");
  await waitFor(() => expect(screen.getByLabelText("New hotel maintenance allocation")).toHaveValue("900.00"));
  await act(async () => resolveOld(response));
  expect(screen.getByLabelText("New hotel maintenance allocation")).toHaveValue("900.00");
  expect(screen.queryByLabelText("Chinaware allocation")).not.toBeInTheDocument();
});

it("clears another user's unsaved draft and recovery controls on an identity change", async () => {
  const view = show(); await screen.findByLabelText("Maintenance allocation"); month("01");
  fireEvent.change(screen.getByLabelText("Maintenance allocation"), { target: { value: "700.00" } });
  mocks.actor = { uid: "new-manager" };
  view.rerender(<MemoryRouter><PurchaseBudgetsPage /></MemoryRouter>);
  await screen.findByLabelText("Maintenance allocation"); month("01");
  await waitFor(() => expect(screen.getByLabelText("Maintenance allocation")).toHaveValue("500.00"));
  expect(screen.getByLabelText("Budget year")).not.toBeDisabled();
  expect(mocks.save).not.toHaveBeenCalled();
});

it("offers a useful empty state and keeps load failures retryable", async () => {
  mocks.load.mockRejectedValueOnce(new Error("Unavailable"));
  mocks.load.mockResolvedValue({ ...response, budgetCategories: [], budgets: [] });
  show(); await screen.findByText("Could not load purchase budgets.");
  expect(screen.queryByRole("region", { name: "Budget summary" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("heading", { name: "Set up your first budget category" });
  expect(screen.getByRole("link", { name: "Configure Purchase Requests" })).toBeInTheDocument();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
});
