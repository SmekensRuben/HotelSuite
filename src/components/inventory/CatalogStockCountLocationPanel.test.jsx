// @vitest-environment jsdom
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: { currentUser: { uid: "counter" } }, choices: vi.fn(), read: vi.fn(), pending: null, retry: vi.fn(), save: vi.fn(), finish: vi.fn(), updatePermission: true }));
vi.mock("../../firebaseConfig", () => ({ auth: mocks.auth }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: (feature, action) => feature === "stockcounts" && (action === "read" || action === "update" && mocks.updatePermission) }));
vi.mock("../../services/firebaseStockCounts", () => ({ getStockCountById: mocks.read, getPendingStockCountMutation: () => mocks.pending, retryPendingStockCountMutation: mocks.retry, getStockCountProductChoices: mocks.choices, updateStockCountLocationCounts: mocks.save, finishStockCountLocation: mocks.finish }));
vi.mock("./StockCountPackageEntry", () => ({ default: () => <span>Package helper</span> }));
vi.mock("./InventoryCostProposal", () => ({ default: () => <span>Cost suggestion</span> }));
import CatalogStockCountLocationPanel from "./CatalogStockCountLocationPanel";
const juice = { id: "juice", name: "Orange juice", baseUnit: "l", barcodes: ["000123"] };
const water = { id: "water", name: "Mineral water", baseUnit: "l", barcodes: [] };
const stockCount = { id: "count", status: "In Progress", currency: "EUR", businessDate: "2026-10-12", revision: 5 };
const empty = { locationId: "outlet-bar", locationName: "Bar", isOutletDefault: true, stockPointType: "outlet", status: "In Progress", stockTemplate: { items: [] }, countedItems: [] };
const template = { ...empty, stockTemplate: { id: "drinks", name: "Drinks", items: [juice, water].map((product) => ({ catalogProductId: product.id, catalogProductName: product.name, baseUnit: product.baseUnit })) } };
const show = (location = empty, hotelUid = "hotel-a", count = stockCount) => <MemoryRouter><CatalogStockCountLocationPanel hotelUid={hotelUid} stockCount={count} location={location} /></MemoryRouter>;
const scan = (barcode) => { fireEvent.click(screen.getByRole("button", { name: "Scan barcode" })); fireEvent.change(screen.getByLabelText("Product barcode"), { target: { value: barcode } }); fireEvent.click(screen.getByRole("button", { name: "Find barcode" })); };
beforeEach(() => { localStorage.clear(); mocks.pending = null; vi.clearAllMocks(); mocks.auth.currentUser = { uid: "counter" }; mocks.updatePermission = true; mocks.choices.mockResolvedValue({ products: [juice, water], nextCursor: null }); mocks.save.mockResolvedValue({}); mocks.finish.mockResolvedValue({}); });
afterEach(cleanup);

it("starts without a template and lets a counter without catalog rights add, focus and finish an explicit zero", async () => {
  render(show()); expect(screen.getByText("Start with the products in front of you")).toBeInTheDocument(); expect(mocks.choices).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Finish Outlet" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Add product" })); fireEvent.click(await screen.findByRole("button", { name: /Orange juice.*Add & count/ }));
  expect(mocks.choices).toHaveBeenCalledWith("hotel-a", "count", "outlet-bar", { search: "", barcode: "" });
  expect(screen.getByLabelText("Count Orange juice")).toHaveFocus(); expect(screen.getByLabelText("Count Orange juice")).toHaveValue(null);
  fireEvent.click(screen.getByRole("button", { name: "Count zero for Orange juice" })); expect(screen.getByText("Counted · zero")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Finish Outlet" }));
  await waitFor(() => expect(mocks.finish).toHaveBeenCalledWith("hotel-a", "count", "outlet-bar", [{ catalogProductId: "juice", quantity: 0, unitCost: null, isCounted: true }], [], "counter", 0));
});

it("persists forgotten articles as uncounted while keeping explicit zero counted", async () => {
  render(show(template)); fireEvent.click(screen.getByRole("button", { name: "Count zero for Orange juice" }));
  expect(within(screen.getByRole("article", { name: "Orange juice" })).getByText("Counted · zero")).toBeInTheDocument();
  expect(within(screen.getByRole("article", { name: "Mineral water" })).getByText("Not counted")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Finish Outlet" })).toBeDisabled(); fireEvent.click(screen.getByRole("button", { name: "Save Counts" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("hotel-a", "count", "outlet-bar", [
    { catalogProductId: "juice", quantity: 0, unitCost: null, isCounted: true }, { catalogProductId: "water", quantity: null, unitCost: null, isCounted: false },
  ], "counter", 0));
});

it("restores an article to uncounted when its explicit zero is cleared", () => {
  render(show(template)); fireEvent.click(screen.getByRole("button", { name: "Count zero for Orange juice" }));
  fireEvent.click(screen.getByRole("button", { name: "Mark Orange juice uncounted" }));
  expect(screen.getByLabelText("Count Orange juice")).toHaveValue(null); expect(screen.queryByText("Counted · zero")).not.toBeInTheDocument();
  expect(screen.getByText("0 / 2 counted · 2 not counted")).toBeInTheDocument();
});

it("keeps an edited article visible in the missing filter and advances to the next missing quantity with Enter", () => {
  render(show(template)); fireEvent.click(screen.getByRole("button", { name: "Not counted (2)" }));
  const input = screen.getByLabelText("Count Orange juice"); fireEvent.focus(input); fireEvent.change(input, { target: { value: "1.5" } });
  expect(input).toBeInTheDocument(); fireEvent.keyDown(input, { key: "Enter" }); expect(screen.getByLabelText("Count Mineral water")).toHaveFocus();
  fireEvent.blur(input); expect(screen.queryByLabelText("Count Orange juice")).not.toBeInTheDocument();
});

it("filters frozen articles by search without requiring directory access on finished counts", () => {
  render(show(template, "hotel-a", { ...stockCount, status: "Finished" }));
  fireEvent.change(screen.getByLabelText("Find products"), { target: { value: "water" } });
  expect(screen.queryByLabelText("Count Orange juice")).not.toBeInTheDocument(); expect(screen.getByLabelText("Count Mineral water")).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Scan barcode" })).not.toBeInTheDocument(); expect(mocks.choices).not.toHaveBeenCalled();
});

it("looks through every barcode page before deciding whether a match is unique", async () => {
  mocks.choices.mockResolvedValueOnce({ products: [juice], nextCursor: "juice" }).mockResolvedValueOnce({ products: [{ ...water, barcodes: ["000123"] }], nextCursor: null });
  render(show()); scan("000123");
  expect(await screen.findByText("This barcode matches more than one article. Choose the physical product below.")).toBeInTheDocument();
  expect(screen.queryByLabelText("Count Orange juice")).not.toBeInTheDocument();
  expect(mocks.choices).toHaveBeenNthCalledWith(2, "hotel-a", "count", "outlet-bar", { search: "", barcode: "000123", afterProductId: "juice" });
  fireEvent.click(screen.getByRole("button", { name: /Mineral water.*Add & count/ }));
  expect(screen.getByLabelText("Count Mineral water")).toHaveFocus(); expect(screen.getByLabelText("Count Mineral water")).toHaveValue(null);
});

it("scans an already included article without duplicating it or changing its quantity", async () => {
  mocks.choices.mockResolvedValue({ products: [juice], nextCursor: null });
  render(show({ ...template, countedItems: [{ catalogProductId: "juice", catalogProductName: "Orange juice", baseUnit: "l", quantity: 3, isCounted: true }] })); scan("000123");
  expect(await screen.findByText(/Found Orange juice/)).toBeInTheDocument(); expect(screen.getAllByLabelText("Count Orange juice")).toHaveLength(1);
  expect(screen.getByLabelText("Count Orange juice")).toHaveValue(3); expect(screen.getByLabelText("Count Orange juice")).toHaveFocus();
});

it("fails a repeated barcode cursor without silently choosing the first matching article", async () => {
  mocks.choices.mockResolvedValue({ products: [juice], nextCursor: "juice" }); render(show()); scan("000123");
  expect(await screen.findByRole("alert")).toHaveTextContent(/incomplete or repeated pagination/);
  expect(screen.queryByLabelText("Count Orange juice")).not.toBeInTheDocument(); expect(mocks.choices).toHaveBeenCalledTimes(2);
});

it("ignores product results from a previous hotel and immediately clears that hotel's draft", async () => {
  let resolve; mocks.choices.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const view = render(show(template)); fireEvent.change(screen.getByLabelText("Count Orange juice"), { target: { value: "7" } }); fireEvent.click(screen.getByRole("button", { name: "Add product" }));
  await waitFor(() => expect(resolve).toBeTypeOf("function")); view.rerender(show(empty, "hotel-b")); resolve({ products: [juice], nextCursor: null });
  await waitFor(() => expect(screen.getByText("Start with the products in front of you")).toBeInTheDocument());
  expect(screen.queryByRole("button", { name: /Orange juice.*Add & count/ })).not.toBeInTheDocument(); expect(screen.queryByLabelText("Count Orange juice")).not.toBeInTheDocument();
});

it("loads matching products through bounded, checked continuation pages", async () => {
  mocks.choices.mockResolvedValueOnce({ products: [], nextCursor: "a" }).mockResolvedValueOnce({ products: [juice], nextCursor: null });
  render(show()); fireEvent.click(screen.getByRole("button", { name: "Add product" }));
  fireEvent.click(await screen.findByRole("button", { name: "Load more product choices" }));
  expect(await screen.findByRole("button", { name: /Orange juice.*Add & count/ })).toBeInTheDocument();
  expect(mocks.choices).toHaveBeenNthCalledWith(2, "hotel-a", "count", "outlet-bar", { search: "", barcode: "", afterProductId: "a" });
});

it("lets a counter correct an accidental new article before saving without removing expected template rows", async () => {
  render(show(template)); fireEvent.click(screen.getByRole("button", { name: "Add product" }));
  mocks.choices.mockResolvedValueOnce({ products: [{ id: "wine", name: "Wine", baseUnit: "l", barcodes: [] }], nextCursor: null });
  fireEvent.change(screen.getByLabelText("Find products"), { target: { value: "Wine" } });
  fireEvent.click(await screen.findByRole("button", { name: /Wine.*Add & count/ }));
  fireEvent.click(screen.getByRole("button", { name: "Remove new article Wine" }));
  expect(screen.queryByLabelText("Count Wine")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Count Orange juice")).toBeInTheDocument(); expect(screen.queryByRole("button", { name: "Remove new article Orange juice" })).not.toBeInTheDocument();
});

it("removes obsolete choices immediately while a new typed query is still debouncing", async () => {
  render(show()); fireEvent.click(screen.getByRole("button", { name: "Add product" }));
  expect(await screen.findByRole("button", { name: /Mineral water.*Add & count/ })).toBeInTheDocument();
  mocks.choices.mockResolvedValueOnce({ products: [juice], nextCursor: null });
  fireEvent.change(screen.getByLabelText("Find products"), { target: { value: "Orange" } });
  expect(screen.queryByRole("button", { name: /Mineral water.*Add & count/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Orange juice.*Add & count/ })).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Finding products");
  expect(await screen.findByRole("button", { name: /Orange juice.*Add & count/ })).toBeInTheDocument();
  expect(mocks.choices).toHaveBeenLastCalledWith("hotel-a", "count", "outlet-bar", { search: "Orange", barcode: "" });
});


it("recovers an interrupted local draft with its original location revision after remount", async () => {
  const view = render(show({ ...template, revision: 2 }));
  fireEvent.change(screen.getByLabelText("Count Orange juice"), { target: { value: "12.5" } });
  fireEvent.change(screen.getByLabelText("Unit cost Orange juice"), { target: { value: "3" } });
  expect(screen.getByText(/Draft saved on this device/)).toBeInTheDocument();
  expect(mocks.save).not.toHaveBeenCalled(); view.unmount();
  render(show({ ...template, revision: 2 }));
  expect(screen.getByLabelText("Count Orange juice")).toHaveValue(null);
  fireEvent.click(screen.getByRole("button", { name: "Restore draft" }));
  expect(screen.getByLabelText("Count Orange juice")).toHaveValue(12.5);
  expect(screen.getByLabelText("Unit cost Orange juice")).toHaveValue(3);
  fireEvent.click(screen.getByRole("button", { name: "Save Counts" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("hotel-a", "count", "outlet-bar", expect.arrayContaining([
    { catalogProductId: "juice", quantity: 12.5, unitCost: 3, isCounted: true },
  ]), "counter", 2));
});

it("keeps a conflicting draft and requires explicit row choices against the latest saved location", async () => {
  mocks.save.mockRejectedValueOnce(Object.assign(new Error("Someone else saved this location."), { code: "functions/aborted" }));
  mocks.read.mockResolvedValue({ ...stockCount, revision: 99, locations: [{ ...template, revision: 3, countedItems: [
    { catalogProductId: "juice", quantity: 8, isCounted: true, unitCost: 2 },
    { catalogProductId: "water", quantity: 5, isCounted: true, unitCost: null },
  ] }] });
  render(show({ ...template, revision: 2 }));
  fireEvent.change(screen.getByLabelText("Count Orange juice"), { target: { value: "3" } });
  fireEvent.click(screen.getByRole("button", { name: "Save Counts" }));
  fireEvent.click(await screen.findByRole("button", { name: "Compare saved counts" }));
  expect(await screen.findByRole("button", { name: "Use reviewed values" })).toBeDisabled();
  expect(screen.getByLabelText("Count Orange juice")).toHaveValue(3);
  fireEvent.click(within(screen.getByRole("group", { name: "Orange juice" })).getByRole("radio", { name: /My draft/ }));
  fireEvent.click(within(screen.getByRole("group", { name: "Mineral water" })).getByRole("radio", { name: /Saved count/ }));
  fireEvent.click(screen.getByRole("button", { name: "Use reviewed values" }));
  expect(screen.getByLabelText("Count Orange juice")).toHaveValue(3);
  expect(screen.getByLabelText("Count Mineral water")).toHaveValue(5);
  fireEvent.click(screen.getByRole("button", { name: "Save Counts" }));
  await waitFor(() => expect(mocks.save).toHaveBeenLastCalledWith("hotel-a", "count", "outlet-bar", [
    { catalogProductId: "juice", quantity: 3, unitCost: null, isCounted: true },
    { catalogProductId: "water", quantity: 5, unitCost: null, isCounted: true },
  ], "counter", 3));
});

it("retains input when connection fails and never hydrates a newer server prop over a dirty form", async () => {
  mocks.save.mockRejectedValueOnce(new Error("Connection lost"));
  const view = render(show({ ...template, revision: 1 }));
  fireEvent.change(screen.getByLabelText("Count Orange juice"), { target: { value: "4" } });
  fireEvent.click(screen.getByRole("button", { name: "Save Counts" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost");
  view.rerender(show({ ...template, revision: 2, countedItems: [{ catalogProductId: "juice", quantity: 9, isCounted: true }] }));
  expect(screen.getByLabelText("Count Orange juice")).toHaveValue(4);
  expect(screen.getByRole("button", { name: "Save Counts" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Compare saved counts" })).toBeInTheDocument();
});

it("keeps a previous user's local draft isolated from the next account", () => {
  const view = render(show(template));
  fireEvent.change(screen.getByLabelText("Count Orange juice"), { target: { value: "7" } });
  mocks.auth.currentUser = { uid: "another-counter" }; view.rerender(show(template));
  expect(screen.getByLabelText("Count Orange juice")).toHaveValue(null);
  expect(screen.queryByRole("button", { name: "Restore draft" })).not.toBeInTheDocument();
  view.unmount(); mocks.auth.currentUser = { uid: "counter" }; render(show(template));
  fireEvent.click(screen.getByRole("button", { name: "Restore draft" }));
  expect(screen.getByLabelText("Count Orange juice")).toHaveValue(7);
});


it("does not discard a different local draft when retrying a saved change from another tab", async () => {
  render(show({ ...template, revision: 2 }));
  fireEvent.change(screen.getByLabelText("Count Orange juice"), { target: { value: "3" } });
  mocks.pending = { hotelUid: "hotel-a", stockCountId: "count", locationId: "outlet-bar", action: "save-location", expectedLocationRevision: 2,
    countedItems: [{ catalogProductId: "juice", quantity: 2, isCounted: true, unitCost: null }, { catalogProductId: "water", quantity: null, isCounted: false, unitCost: null }] };
  act(() => window.dispatchEvent(new Event("stock-count-command-changed")));
  mocks.retry.mockImplementationOnce(async () => { mocks.pending = null; return { locationRevision: 3, revision: 6 }; });
  fireEvent.click(screen.getByRole("button", { name: "Retry saved change" }));
  expect(await screen.findByText(/Your current draft has different values/)).toBeInTheDocument();
  expect(screen.getByLabelText("Count Orange juice")).toHaveValue(3);
  expect(screen.getByText(/Draft saved on this device/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Compare saved counts" })).toBeInTheDocument();
});
