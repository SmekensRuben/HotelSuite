import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OrdersPage from "./OrdersPage";

const mocks = vi.hoisted(() => ({ hotel: "hotel-a", permissions: [], orders: vi.fn(), suppliers: vi.fn(), display: vi.fn() }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotel, permissions: mocks.permissions, isPlatformAdmin: false, subscriptionActive: true, subscription: { modules: ["procurement", "contracts", "frontoffice", "groups", "revenue"], modulePolicyVersion: 1, status: "active", validUntil: null } }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key) => key }) }));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../layout/PageShell", () => ({ default: ({ children }) => <main>{children}</main> }));
vi.mock("../../services/firebaseOrders", () => ({ getOrders: mocks.orders, listOrderStatuses: () => ["Created"] }));
vi.mock("../../services/firebaseSuppliers", () => ({ getSuppliers: mocks.suppliers }));
vi.mock("../../services/firebaseUserManagement", () => ({ getHotelUserDisplayName: mocks.display }));
const openCombo = (label) => fireEvent.focus(screen.getByRole("combobox", { name: label }));
const chooseCombo = async (label, option) => { openCombo(label); fireEvent.click(await screen.findByRole("option", { name: option })); };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

describe("scoped order loading", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.hotel = "hotel-a"; mocks.permissions = ["orders.read", "suppliers.read"]; mocks.suppliers.mockResolvedValue([]); mocks.display.mockResolvedValue("Hotel employee"); });
  it("shows frozen supplier names and supplier ID fallbacks for an orders-only reader without fetching suppliers", async () => {
    mocks.permissions = ["orders.read"];
    mocks.suppliers.mockRejectedValue(new Error("Forbidden supplier read"));
    mocks.orders.mockResolvedValue([
      { id: "order-a", deliveryDate: "2027-05-01", status: "Created", supplierId: "supplier-a", supplierName: "Frozen supplier" },
      { id: "order-b", deliveryDate: "2027-05-02", status: "Created", supplierId: "supplier-b" },
    ]);
    render(<OrdersPage />);
    const firstRow = (await screen.findByText("2027-05-01")).closest("tr");
    expect(within(firstRow).getByText("Frozen supplier")).toBeInTheDocument();
    const secondRow = screen.getByText("2027-05-02").closest("tr");
    expect(within(secondRow).getByText("supplier-b")).toBeInTheDocument();
    openCombo("Filter supplier");
    expect(screen.getByRole("option", { name: "Frozen supplier" })).toBeInTheDocument();
    expect(mocks.suppliers).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("keeps orders available when an authorized optional supplier lookup fails", async () => {
    mocks.orders.mockResolvedValue([{ id: "order-a", deliveryDate: "2027-05-01", status: "Created", supplierId: "supplier-a", supplierName: "Frozen supplier" }]);
    mocks.suppliers.mockRejectedValueOnce(new Error("Supplier names offline")).mockResolvedValue([{ id: "supplier-a", name: "Current supplier" }]);
    render(<OrdersPage />);
    expect(await screen.findByText("2027-05-01")).toBeInTheDocument();
    expect(await screen.findByText("Supplier names offline")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    openCombo("Filter supplier");
    expect(await screen.findByRole("option", { name: "Current supplier" })).toBeInTheDocument();
    expect(mocks.orders).toHaveBeenCalledTimes(1);
  });
  it("shows orders while staff projections are pending and falls back per user on failure", async () => {
    mocks.permissions = ["orders.read"];
    const pending = deferred();
    mocks.display.mockImplementation((_, userId) => userId === "creator" ? pending.promise : Promise.reject(new Error("Disabled staff projection")));
    mocks.orders.mockResolvedValue([
      { id: "order-a", status: "Created", deliveryDate: "2027-05-01", createdBy: "creator" },
      { id: "order-b", status: "Created", deliveryDate: "2027-05-02", createdBy: "failed-user", createdByName: "Saved creator" },
    ]);
    render(<OrdersPage />);
    const row = (await screen.findByText("2027-05-01")).closest("tr");
    expect(within(row).getAllByText("Unknown user").length).toBeGreaterThan(0);
    expect(screen.queryByText("creator")).not.toBeInTheDocument();
    expect(within(screen.getByText("2027-05-02").closest("tr")).getByText("Saved creator")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => pending.resolve("Current employee"));
    expect(within(row).getByText("Current employee")).toBeInTheDocument();
    openCombo("Filter creator");
    expect(screen.getByRole("option", { name: "Saved creator" })).toBeInTheDocument();
    expect(mocks.orders).toHaveBeenCalledTimes(1);
  });
  it("ignores previous-hotel staff labels after current orders have loaded", async () => {
    const oldNames = deferred();
    mocks.display.mockImplementation((hotel) => hotel === "hotel-a" ? oldNames.promise : Promise.resolve("Current employee"));
    mocks.orders.mockImplementation((hotel) => Promise.resolve([{ id: hotel, status: "Created", deliveryDate: hotel === "hotel-a" ? "2027-05-01" : "2027-05-02", createdBy: "creator" }]));
    const view = render(<OrdersPage />);
    await screen.findByText("2027-05-01");
    await waitFor(() => expect(mocks.display).toHaveBeenCalledWith("hotel-a", "creator"));
    mocks.hotel = "hotel-b";
    view.rerender(<OrdersPage />);
    openCombo("Filter creator");
    await screen.findByRole("option", { name: "Current employee" });
    await act(async () => oldNames.resolve("Previous employee"));
    expect(screen.queryByText("Previous employee")).not.toBeInTheDocument();
    expect(within(screen.getByText("2027-05-02").closest("tr")).getByText("Current employee")).toBeInTheDocument();
  });
  it("clears old supplier and creator filters when the selected hotel changes", async () => {
    mocks.display.mockImplementation((hotel) => Promise.resolve(`${hotel} employee`));
    mocks.orders.mockImplementation((hotel) => Promise.resolve([{ id: hotel, status: "Created", deliveryDate: hotel === "hotel-a" ? "2027-05-01" : "2027-05-02", supplierId: `${hotel}-supplier`, supplierName: `${hotel} supplier`, createdBy: `${hotel}-creator` }]));
    const view = render(<OrdersPage />);
    await screen.findByText("2027-05-01");
    await chooseCombo("Filter supplier", "hotel-a supplier");
    await chooseCombo("Filter creator", "hotel-a employee");
    mocks.hotel = "hotel-b";
    view.rerender(<OrdersPage />);
    expect(await screen.findByText("2027-05-02")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Filter supplier" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Filter creator" })).toHaveValue("");
  });
  it("completes failed loading and retries with scoped staff projections", async () => {
    mocks.orders.mockRejectedValueOnce(new Error("Orders offline")).mockResolvedValue([{ id: "order-a", deliveryDate: "2027-05-01", status: "Created", createdBy: "employee" }]);
    render(<OrdersPage />);
    expect(await screen.findByText("Orders offline")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("2027-05-01")).toBeInTheDocument();
    expect(mocks.display).toHaveBeenCalledWith("hotel-a", "employee");
  });
  it("discards orders from the previous hotel when requests resolve in reverse", async () => {
    const old = deferred(), current = deferred();
    mocks.orders.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const view = render(<OrdersPage />);
    mocks.hotel = "hotel-b";
    view.rerender(<OrdersPage />);
    await act(async () => current.resolve([{ id: "order-b", deliveryDate: "2027-05-02", status: "Created" }]));
    await act(async () => old.resolve([{ id: "order-a", deliveryDate: "2027-05-01", status: "Created" }]));
    expect(screen.getByText("2027-05-02")).toBeInTheDocument();
    expect(screen.queryByText("2027-05-01")).not.toBeInTheDocument();
  });
  it("resolves both actor fields without showing document identities", async () => {
    mocks.permissions = ["orders.read"];
    mocks.display.mockImplementation((_, id) => Promise.resolve(id === "employee-a" ? "Ruben Smekens" : id));
    mocks.orders.mockResolvedValue([{ id: "order-a", deliveryDate: "2027-05-01", status: "Created", createdBy: "employee-a", updatedBy: "opaque-actor-id" }]);
    render(<OrdersPage />);
    const row = (await screen.findByText("2027-05-01")).closest("tr");
    await waitFor(() => expect(within(row).getByText("Ruben Smekens")).toBeInTheDocument());
    expect(within(row).getByText("Unknown user")).toBeInTheDocument();
    expect(screen.queryByText("opaque-actor-id")).not.toBeInTheDocument();
  });
  it("shows order price bases beside unchanged totals and leaves historical bases unknown", async () => {
    mocks.permissions = ["orders.read"];
    mocks.orders.mockResolvedValue([
      { id: "gross", deliveryDate: "2027-05-01", status: "Created", priceBasis: "gross", currency: "EUR", totalAmount: 121 },
      { id: "net", deliveryDate: "2027-05-02", status: "Created", priceBasis: "net", currency: "EUR", totalAmount: 100 },
      { id: "legacy", deliveryDate: "2027-05-03", status: "Created", currency: "EUR", totalAmount: 121 },
    ]);
    render(<OrdersPage />);
    const gross = (await screen.findByText("2027-05-01")).closest("tr");
    expect(within(gross).getByText("121.00 EUR")).toBeInTheDocument();
    expect(within(gross).getByText("Gross (including VAT)")).toBeInTheDocument();
    const net = screen.getByText("2027-05-02").closest("tr");
    expect(within(net).getByText("100.00 EUR")).toBeInTheDocument();
    expect(within(net).getByText("Net (excluding VAT)")).toBeInTheDocument();
    const legacy = screen.getByText("2027-05-03").closest("tr");
    expect(within(legacy).getByText("Unknown (VAT treatment unavailable)")).toBeInTheDocument();
    expect(within(legacy).getByText("121.00 EUR")).toBeInTheDocument();
  });

});
