import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import StockCountLocationPage from "./StockCountLocationPage";
import StockCountCreatePage from "./StockCountCreatePage";
import StockCountDetailPage from "./StockCountDetailPage";

const mocks = vi.hoisted(() => ({ hotel: "hotel-a", permissions: ["stockcounts.read", "stockcounts.update", "stockcounts.create"],
  getCount: vi.fn(), sources: vi.fn(), save: vi.fn(), finish: vi.fn(), finishParent: vi.fn(), create: vi.fn(), products: vi.fn(), outlets: vi.fn(), navigate: vi.fn() }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotel }) }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: (feature, action) => mocks.permissions.includes(`${feature}.${action}`) }));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate, useParams: () => ({ stockCountId: "stock-a", locationId: "store" }) }));
vi.mock("../../firebaseConfig", () => ({ auth: { currentUser: { uid: "counter" } }, signOut: vi.fn() }));
vi.mock("../../services/firebaseStockCounts", () => ({ getStockCountById: mocks.getCount, getStockCountSources: mocks.sources,
  updateStockCountLocationCounts: mocks.save, finishStockCountLocation: mocks.finish, createStockCount: mocks.create,
  finishStockCount: mocks.finishParent,
  STOCK_COUNT_TYPES: ["Ad Hoc", "Daily", "Weekly", "Month-End"] }));
vi.mock("../../services/firebaseProducts", () => ({ getSupplierProducts: mocks.products }));
vi.mock("../../services/firebaseSettings", () => ({ getOutlets: mocks.outlets }));
vi.mock("../layout/HeaderBar", () => ({ default: () => null }));
vi.mock("../shared/DataListTable", () => ({ default: () => null }));
vi.mock("../shared/Modal", () => ({ default: ({ open, children }) => open ? <section>{children}</section> : null }));
const count = (label = "Coffee", revision = 7) => ({ id: "stock-a", name: "Weekly inventory", status: "In Progress", revision,
  locations: [{ locationId: "store", locationName: "Store", stockTemplateId: "template", status: "In Progress",
    stockTemplate: { id: "template", name: "Weekly", items: [{ supplierProductId: "coffee", outletId: "bar",
      supplierProductName: label, outletName: "Bar", pricePerPurchaseUnit: 12.5 }] }, countedItems: [] }] });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => {
  vi.clearAllMocks(); mocks.hotel = "hotel-a"; mocks.permissions = ["stockcounts.read", "stockcounts.update", "stockcounts.create"];
  mocks.getCount.mockResolvedValue(count()); mocks.sources.mockResolvedValue([{ locationId: "store", locationName: "Store", templates: [{ id: "template", name: "Weekly" }] }]);
  mocks.products.mockRejectedValue(new Error("Catalog denied")); mocks.outlets.mockRejectedValue(new Error("Outlets denied"));
  mocks.save.mockResolvedValue({ revision: 8 }); mocks.finish.mockResolvedValue({ revision: 8 }); mocks.finishParent.mockResolvedValue({ revision: 8 }); mocks.create.mockResolvedValue({ id: "new-stock" });
});
describe("normal stock role workflow", () => {
  it("loads and saves snapshot rows without catalog/outlet access and preserves loaded revision", async () => {
    render(<StockCountLocationPage />);
    await screen.findByText("Coffee");
    expect(mocks.products).not.toHaveBeenCalled(); expect(mocks.outlets).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Add Supplier Product" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Count"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Counts" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("hotel-a", "stock-a", "store",
      [expect.objectContaining({ quantity: 4, supplierProductId: "coffee" })], "counter", 7));
  });
  it("creates from authorized minimal source metadata without querying private catalog configuration", async () => {
    render(<StockCountCreatePage />);
    await screen.findByText("Store");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Weekly count" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Stock Count" }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith("hotel-a", { name: "Weekly count", type: "Ad Hoc",
      locations: [{ locationId: "store", stockTemplateId: "template" }] }));
    expect(mocks.products).not.toHaveBeenCalled(); expect(mocks.outlets).not.toHaveBeenCalled();
  });
  it("shows failed loading and retries the actual scoped read", async () => {
    mocks.getCount.mockRejectedValueOnce(new Error("Offline"));
    render(<StockCountLocationPage />);
    await screen.findByText("Offline");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Coffee");
    expect(mocks.getCount).toHaveBeenCalledTimes(2);
  });
  it("ignores a delayed previous hotel's stock record and revision", async () => {
    const first = deferred(), second = deferred();
    mocks.getCount.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = render(<StockCountLocationPage />);
    mocks.hotel = "hotel-b"; view.rerender(<StockCountLocationPage />);
    await act(async () => second.resolve(count("Hotel B coffee", 9)));
    await screen.findByText("Hotel B coffee");
    await act(async () => first.resolve(count("Private hotel A coffee", 7)));
    expect(screen.queryByText("Private hotel A coffee")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Count"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Counts" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("hotel-b", "stock-a", "store", expect.any(Array), "counter", 9));
  });
  it("loads complete optional add-product catalog beyond the first page when permitted", async () => {
    mocks.permissions.push("supplierproducts.read", "outlets.read");
    mocks.products.mockImplementation(async (_hotel, options) => options.cursor
      ? { products: [{ id: "later", supplierProductName: "Later product" }], hasMore: false }
      : { products: [{ id: "early", supplierProductName: "Early product" }], hasMore: true, cursor: "next" });
    mocks.outlets.mockResolvedValue([{ id: "bar", name: "Bar" }]);
    render(<StockCountLocationPage />); await screen.findByText("Coffee");
    fireEvent.click(screen.getByRole("button", { name: "Add Supplier Product" }));
    await screen.findByText("Later product");
    expect(mocks.products).toHaveBeenCalledTimes(2);
  });
  it.each(["products", "outlets"])("keeps snapshot counting available when optional %s fail and retries only add-product sources", async (source) => {
    mocks.permissions.push("supplierproducts.read", "outlets.read");
    mocks.products.mockResolvedValue({ products: [{ id: "later", supplierProductName: "Later product" }], hasMore: false });
    mocks.outlets.mockResolvedValue([{ id: "bar", name: "Bar" }]);
    mocks[source].mockRejectedValueOnce(new Error("Optional source offline"));
    render(<StockCountLocationPage />);
    await screen.findByText("Optional source offline");
    expect(await screen.findByText("Coffee")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Supplier Product" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Count"), { target: { value: "3" } });
    const command = deferred(); mocks.save.mockReturnValueOnce(command.promise);
    fireEvent.click(screen.getByRole("button", { name: "Save Counts" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("hotel-a", "stock-a", "store",
      [expect.objectContaining({ quantity: 3 })], "counter", 7));
    fireEvent.click(screen.getByRole("button", { name: "Retry add-product sources" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add Supplier Product" })).toBeEnabled());
    expect(screen.getByLabelText("Count")).toHaveValue(3);
    expect(mocks.getCount).toHaveBeenCalledTimes(1);
    expect(mocks.products).toHaveBeenCalledTimes(2); expect(mocks.outlets).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Add Supplier Product" }));
    await screen.findByText("Later product");
    await act(async () => command.resolve({ revision: 8 }));
  });
  it("keeps late optional catalog results scoped to the current hotel", async () => {
    mocks.permissions.push("supplierproducts.read", "outlets.read");
    const previous = deferred(), current = deferred();
    mocks.products.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
    mocks.outlets.mockResolvedValue([{ id: "bar", name: "Bar" }]);
    mocks.getCount.mockImplementation(async (hotel) => count(hotel === "hotel-b" ? "Hotel B coffee" : "Coffee", hotel === "hotel-b" ? 9 : 7));
    const view = render(<StockCountLocationPage />); await screen.findByText("Coffee");
    mocks.hotel = "hotel-b"; view.rerender(<StockCountLocationPage />); await screen.findByText("Hotel B coffee");
    await act(async () => previous.resolve({ products: [{ id: "private", supplierProductName: "Private hotel A product" }], hasMore: false }));
    expect(screen.getByRole("button", { name: "Add Supplier Product" })).toBeDisabled();
    await act(async () => current.resolve({ products: [{ id: "current", supplierProductName: "Hotel B product" }], hasMore: false }));
    fireEvent.click(screen.getByRole("button", { name: "Add Supplier Product" }));
    expect(await screen.findByText("Hotel B product")).toBeInTheDocument();
    expect(screen.queryByText("Private hotel A product")).not.toBeInTheDocument();
  });
  it("ignores a late stock save response after the user switches hotels", async () => {
    const saved = deferred(); mocks.save.mockReturnValueOnce(saved.promise);
    const view = render(<StockCountLocationPage />); await screen.findByText("Coffee");
    fireEvent.change(screen.getByLabelText("Count"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Counts" }));
    mocks.hotel = "hotel-b"; mocks.getCount.mockResolvedValue(count("Hotel B coffee", 9));
    view.rerender(<StockCountLocationPage />); await screen.findByText("Hotel B coffee");
    await act(async () => saved.resolve({ revision: 8 }));
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save Counts" })).toBeEnabled();
  });
  it("stock detail ignores a reversed previous hotel's read", async () => {
    const first = deferred(), second = deferred();
    mocks.getCount.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = render(<StockCountDetailPage />);
    mocks.hotel = "hotel-b"; view.rerender(<StockCountDetailPage />);
    await act(async () => second.resolve({ ...count(), name: "Hotel B inventory" }));
    await screen.findByText("Hotel B inventory");
    await act(async () => first.resolve({ ...count(), name: "Private hotel A inventory" }));
    expect(screen.queryByText("Private hotel A inventory")).not.toBeInTheDocument();
  });
  it.each(["save", "finish"])("ignores late location %s navigation after unmount in StrictMode", async (action) => {
    const command = deferred(); mocks[action].mockReturnValueOnce(command.promise);
    const view = render(<React.StrictMode><StockCountLocationPage /></React.StrictMode>);
    await screen.findByText("Coffee");
    fireEvent.change(screen.getByLabelText("Count"), { target: { value: "1" } });
    if (action === "finish") {
      fireEvent.click(screen.getByRole("button", { name: "Set Finished" }));
      fireEvent.click(screen.getByRole("button", { name: "Yes, set finished" }));
    } else fireEvent.click(screen.getByRole("button", { name: "Save Counts" }));
    await waitFor(() => expect(mocks[action]).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => command.resolve({ revision: 8 }));
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it("ignores a late creation response after the user leaves the page", async () => {
    const command = deferred(); mocks.create.mockReturnValueOnce(command.promise);
    const view = render(<StockCountCreatePage />); await screen.findByText("Store");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Weekly count" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Stock Count" }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    view.unmount(); await act(async () => command.resolve({ id: "new-stock" }));
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it("avoids a parent refresh after finishing a count on an unmounted detail page", async () => {
    const command = deferred(); mocks.finishParent.mockReturnValueOnce(command.promise);
    const finishedLocations = count().locations.map((location) => ({ ...location, status: "Finished" }));
    mocks.getCount.mockResolvedValue({ ...count(), locations: finishedLocations });
    const view = render(<StockCountDetailPage />);
    const finish = await screen.findByRole("button", { name: "Finish Stock Count" });
    await waitFor(() => expect(finish).toBeEnabled()); fireEvent.click(finish);
    await waitFor(() => expect(mocks.finishParent).toHaveBeenCalledTimes(1));
    view.unmount(); await act(async () => command.resolve({ revision: 8 }));
    expect(mocks.getCount).toHaveBeenCalledTimes(1);
  });
});
