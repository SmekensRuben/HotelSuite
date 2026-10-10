import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OrderEditPage from "./OrderEditPage";
import OrderDetailPage from "./OrderDetailPage";
import ProductDetailPage from "./ProductDetailPage";
import SupplierProductDetailPage from "./SupplierProductDetailPage";
import SupplierDetailPage from "./SupplierDetailPage";

const mocks = vi.hoisted(() => ({ hotel: "hotel-a", id: "record-a", permissions: [], order: vi.fn(), catalog: vi.fn(), supplierProduct: vi.fn(), supplier: vi.fn(), deleteCatalog: vi.fn(), deleteSupplierProduct: vi.fn(), deleteSupplier: vi.fn(), display: vi.fn(), approvers: vi.fn(), update: vi.fn(), navigate: vi.fn() }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotel, hotelName: mocks.hotel, permissions: mocks.permissions, subscriptionActive: true, subscription: { modules: ["procurement", "contracts", "frontoffice", "groups", "revenue"], modulePolicyVersion: 1, status: "active", validUntil: null }, isPlatformAdmin: false }) }));
vi.mock("react-router-dom", () => ({ useParams: () => ({ orderId: mocks.id, productId: mocks.id, supplierId: mocks.id }), useNavigate: () => mocks.navigate }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key) => key }) }));
vi.mock("../layout/HeaderBar", () => ({ default: () => null }));
vi.mock("../../firebaseConfig", () => ({ auth: { currentUser: { uid: "employee" } }, signOut: vi.fn() }));
vi.mock("../../services/firebaseOrders", () => ({ getOrderById: mocks.order, updateOrder: mocks.update, deleteOrder: vi.fn(), confirmOrder: vi.fn(), reviewOrderDelivery: vi.fn() }));
vi.mock("../../services/firebaseProducts", () => ({ getCatalogProduct: mocks.catalog, getSupplierProduct: mocks.supplierProduct, deleteCatalogProduct: mocks.deleteCatalog, deleteSupplierProduct: mocks.deleteSupplierProduct }));
vi.mock("../../services/firebaseSuppliers", () => ({ getSupplier: mocks.supplier, deleteSupplier: mocks.deleteSupplier }));
vi.mock("../../services/firebaseUserManagement", () => ({ getHotelUserDisplayName: mocks.display }));
vi.mock("../../services/firebaseSettings", () => ({ getOutletApprovers: mocks.approvers }));

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const record = (name = "Current record", overrides = {}) => ({ id: mocks.id, name, supplierProductName: name, status: "Created", deliveryDate: "2027-05-01", createdBy: "creator", updatedBy: "editor", products: [{ supplierProductId: "product", supplierProductName: name, qtyPurchaseUnits: 3, pricePerPurchaseUnit: 2 }], ...overrides });
const cases = [
  ["order edit", OrderEditPage, "order", ["orders.read", "orders.update"]],
  ["order detail", OrderDetailPage, "order", "orders.read"],
  ["catalog product", ProductDetailPage, "catalog", "catalogproducts.read"],
  ["supplier product", SupplierProductDetailPage, "supplierProduct", "supplierproducts.read"],
  ["supplier detail", SupplierDetailPage, "supplier", "suppliers.read"],
];

describe("scoped procurement records and optional staff labels", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.hotel = "hotel-a"; mocks.id = "record-a"; mocks.permissions = [];
    mocks.display.mockResolvedValue("Employee name"); mocks.approvers.mockResolvedValue([]); mocks.update.mockResolvedValue();
    for (const service of ["order", "catalog", "supplierProduct", "supplier"]) mocks[service].mockResolvedValue(record());
  });
  afterEach(() => vi.useRealTimers());

  it.each(cases)("%s exposes failed core loading and retries instead of remaining in loading", async (_, Component, service, permission) => {
    mocks.permissions = Array.isArray(permission) ? permission : [permission];
    mocks[service].mockRejectedValueOnce(new Error("Record offline")).mockResolvedValue(record());
    render(<Component />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Record offline");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect((await screen.findAllByText("Current record")).length).toBeGreaterThan(0);
  });

  it.each(cases)("%s remains usable when optional staff labels fail", async (_, Component, service, permission) => {
    mocks.permissions = Array.isArray(permission) ? permission : [permission];
    mocks.display.mockRejectedValue(new Error("Staff projection offline"));
    mocks[service].mockResolvedValue(record());
    render(<Component />);
    expect((await screen.findAllByText("Current record")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("creator")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(mocks.display).toHaveBeenCalledWith("hotel-a", "creator");
  });

  it.each(cases)("%s ignores a previous hotel's core response", async (_, Component, service, permission) => {
    mocks.permissions = Array.isArray(permission) ? permission : [permission];
    const old = deferred(), current = deferred();
    mocks[service].mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const view = render(<Component />);
    mocks.hotel = "hotel-b"; mocks.id = "record-b";
    view.rerender(<Component />);
    await act(async () => current.resolve(record("Current record")));
    await act(async () => old.resolve(record("Previous hotel record")));
    expect(screen.queryByText("Previous hotel record")).not.toBeInTheDocument();
    expect(screen.getAllByText("Current record").length).toBeGreaterThan(0);
    expect(mocks.display.mock.calls.every(([hotel]) => hotel === "hotel-b")).toBe(true);
  });

  it.each(cases)("%s ignores a previous hotel's late staff labels", async (_, Component, service, permission) => {
    mocks.permissions = Array.isArray(permission) ? permission : [permission];
    const oldNames = deferred();
    mocks.display.mockImplementation((hotel) => hotel === "hotel-a" ? oldNames.promise : Promise.resolve("Current hotel employee"));
    mocks[service].mockResolvedValueOnce(record("First record")).mockResolvedValue(record());
    const view = render(<Component />);
    await screen.findAllByText("First record");
    await waitFor(() => expect(mocks.display).toHaveBeenCalledWith("hotel-a", "creator"));
    mocks.hotel = "hotel-b"; mocks.id = "record-b";
    view.rerender(<Component />);
    await screen.findAllByText("Current hotel employee");
    await act(async () => oldNames.resolve("Previous hotel employee"));
    expect(screen.queryByText("Previous hotel employee")).not.toBeInTheDocument();
    expect(screen.getAllByText("Current hotel employee").length).toBeGreaterThan(0);
  });

  it("clears edited dates and lines before loading a different hotel/order", async () => {
    mocks.permissions = ["orders.read", "orders.update"];
    const current = deferred();
    mocks.order.mockResolvedValueOnce(record("First order")).mockReturnValueOnce(current.promise);
    const view = render(<OrderEditPage />);
    await screen.findByText("First order");
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "9" } });
    fireEvent.change(screen.getByLabelText("Delivery Date"), { target: { value: "2029-01-01" } });
    mocks.hotel = "hotel-b"; mocks.id = "record-b";
    view.rerender(<OrderEditPage />);
    expect(screen.queryByText("First order")).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    await act(async () => current.resolve(record()));
    expect(screen.getByRole("spinbutton")).toHaveValue(3);
    expect(screen.getByLabelText("Delivery Date")).toHaveValue("2027-05-01");
  });

  it("ignores completion of a previous hotel's order save", async () => {
    mocks.permissions = ["orders.read", "orders.update"];
    const save = deferred();
    mocks.update.mockReturnValueOnce(save.promise);
    const view = render(<OrderEditPage />);
    await screen.findByText("Current record");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith("hotel-a", "record-a", expect.any(Object), "employee", 0));
    mocks.hotel = "hotel-b"; mocks.id = "record-b";
    view.rerender(<OrderEditPage />);
    await screen.findByText("Current record");
    await act(async () => save.resolve());
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("uses frozen supplier names for an orders-only reader without supplier or approval lookups", async () => {
    mocks.permissions = ["orders.read"];
    mocks.order.mockResolvedValue(record("Order line", { supplierId: "supplier", supplierName: "Frozen supplier", outletId: "bar" }));
    mocks.supplier.mockRejectedValue(new Error("Forbidden supplier read"));
    render(<OrderDetailPage />);
    expect(await screen.findByText("Frozen supplier", { exact: false })).toBeInTheDocument();
    expect(mocks.supplier).not.toHaveBeenCalled();
    expect(mocks.approvers).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Confirm Order" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("keeps the dispatch dialog and current order visible when a poll fails", async () => {
    mocks.permissions = ["orders.read", "orders.approve"];
    mocks.order.mockResolvedValue(record("Order line", { outletId: "bar" }));
    mocks.approvers.mockResolvedValue([{ id: "employee" }]);
    render(<OrderDetailPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm Order" })).toBeEnabled());
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Confirm Order" }));
    mocks.order.mockRejectedValueOnce(new Error("Poll offline"));
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(screen.getByText("Order line")).toBeInTheDocument();
    expect(screen.getByText("Confirm Order & Dispatch")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Poll offline");
    expect(screen.queryByText("Loading order...")).not.toBeInTheDocument();
  });

  const deletionCases = [
    ["catalog product", ProductDetailPage, "deleteCatalog", "catalogproducts", "products.actions.delete"],
    ["supplier product", SupplierProductDetailPage, "deleteSupplierProduct", "supplierproducts", "products.actions.delete"],
    ["supplier", SupplierDetailPage, "deleteSupplier", "suppliers", "Delete supplier"],
  ];
  const confirmDeletion = (title) => {
    fireEvent.click(screen.getByTitle(title));
    const label = title === "Delete supplier" ? "Delete" : title;
    const buttons = screen.getAllByRole("button", { name: label });
    fireEvent.click(buttons.at(-1));
  };

  it.each(deletionCases)("ignores %s deletion completion after a hotel change", async (_, Component, deleter, feature, title) => {
    mocks.permissions = [`${feature}.read`, `${feature}.delete`];
    const pending = deferred();
    mocks[deleter].mockReturnValueOnce(pending.promise);
    const view = render(<Component />);
    await screen.findAllByText("Current record");
    confirmDeletion(title);
    await waitFor(() => expect(mocks[deleter]).toHaveBeenCalledWith("hotel-a", "record-a"));
    mocks.hotel = "hotel-b";
    view.rerender(<Component />);
    await screen.findAllByText("Current record");
    await act(async () => pending.resolve());
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(deletionCases)("shows %s deletion failures and allows retry in the reviewed scope", async (_, Component, deleter, feature, title) => {
    mocks.permissions = [`${feature}.read`, `${feature}.delete`];
    mocks[deleter].mockRejectedValueOnce(new Error("Delete offline")).mockResolvedValueOnce();
    render(<Component />);
    await screen.findAllByText("Current record");
    confirmDeletion(title);
    expect(await screen.findByRole("alert")).toHaveTextContent("Delete offline");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledTimes(1));
    expect(mocks[deleter]).toHaveBeenNthCalledWith(2, "hotel-a", "record-a");
  });
});
