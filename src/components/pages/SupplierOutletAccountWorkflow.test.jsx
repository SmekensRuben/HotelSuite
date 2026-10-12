import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SupplierOutletAccountCreatePage from "./SupplierOutletAccountCreatePage";
import SuppliersPage from "./SuppliersPage";

const mocks = vi.hoisted(() => ({ hotel: "hotel-a", suppliers: vi.fn(), outlets: vi.fn(), save: vi.fn(), navigate: vi.fn() }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotel, permissions: ["suppliers.read", "suppliers.update"], subscriptionActive: true, subscription: { modules: ["procurement"], modulePolicyVersion: 1, status: "active", validUntil: null } }) }));
vi.mock("react-router-dom", () => ({ useParams: () => ({ supplierId: "" }), useNavigate: () => mocks.navigate }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key) => key }) }));
vi.mock("../layout/HeaderBar", () => ({ default: () => null }));
vi.mock("../../firebaseConfig", () => ({ auth: { currentUser: { uid: "employee" } }, signOut: vi.fn() }));
vi.mock("../../services/firebaseSuppliers", () => ({ getSuppliers: mocks.suppliers, createSupplierOutletAccount: mocks.save }));
vi.mock("../../services/firebaseSettings", () => ({ getOutlets: mocks.outlets }));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { resolve, promise }; };

describe("supplier selectors and scoped loading", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.hotel = "hotel-a"; mocks.suppliers.mockResolvedValue([{ id: "supplier-one", name: "Same supplier" }, { id: "supplier-two", name: "Same supplier" }]); mocks.outlets.mockResolvedValue([{ id: "bar", name: "Bar" }, { id: "old", name: "Archived outlet", archived: true }]); mocks.save.mockResolvedValue("account"); });
  it("uses the selected supplier's stable identity even when names are duplicated and excludes archived outlets", async () => {
    render(<SupplierOutletAccountCreatePage />);
    const supplier = screen.getByRole("combobox", { name: "Supplier *" });
    fireEvent.focus(supplier);
    const options = await screen.findAllByRole("option", { name: "Same supplier" });
    fireEvent.click(options[1]);
    const outlet = screen.getByRole("combobox", { name: "Outlet *" }); fireEvent.focus(outlet);
    expect(screen.queryByRole("option", { name: "Archived outlet" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "Bar" }));
    fireEvent.change(screen.getByLabelText("Account number *"), { target: { value: "BAR-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save account" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("hotel-a", expect.objectContaining({ supplierId: "supplier-two", outletId: "bar", accountNumber: "BAR-2" }), "employee"));
  });
  it("shows failed supplier loading and permits a retry", async () => {
    mocks.suppliers.mockRejectedValueOnce(new Error("Supplier connection unavailable")).mockResolvedValue([{ id: "one", name: "Recovered supplier" }]);
    render(<SuppliersPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Supplier connection unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Recovered supplier")).toBeInTheDocument();
  });
  it("ignores suppliers arriving from a previous hotel", async () => {
    const pending = deferred(); mocks.suppliers.mockImplementation((hotel) => hotel === "hotel-a" ? pending.promise : Promise.resolve([{ id: "current", name: "Current hotel supplier" }]));
    const view = render(<SuppliersPage />); mocks.hotel = "hotel-b"; view.rerender(<SuppliersPage />);
    expect(await screen.findByText("Current hotel supplier")).toBeInTheDocument();
    await act(async () => pending.resolve([{ id: "old", name: "Previous hotel supplier" }]));
    expect(screen.queryByText("Previous hotel supplier")).not.toBeInTheDocument();
  });
});
