import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HeaderBar from "./HeaderBar";

let permissions;

vi.mock("../../contexts/HotelContext", () => ({
  useHotelContext: () => ({
    hotelUid: "hotel-a",
    hotelUids: [],
      subscriptionActive: true,
    subscription: { modules: ["procurement", "contracts", "frontoffice", "groups", "revenue"], modulePolicyVersion: 1, status: "active", validUntil: null },
    permissions,
    isPlatformAdmin: false,
    selectHotel: vi.fn(),
  }),
}));
vi.mock("../../firebaseConfig", () => ({ db: {}, doc: vi.fn(), getDoc: vi.fn() }));

function renderHeader() {
  return render(<MemoryRouter><HeaderBar today="today" onLogout={vi.fn()} /></MemoryRouter>);
}

describe("HeaderBar Front Office permissions", () => {
  beforeEach(() => { permissions = []; });

  it("hides Front Office for a user without permissions", () => {
    renderHeader();
    expect(screen.queryByText("Front Office")).not.toBeInTheDocument();
    expect(screen.queryByText("Arrivals")).not.toBeInTheDocument();
    expect(screen.queryByText("Made Reservations")).not.toBeInTheDocument();
  });

  it("shows Front Office to reservations readers", () => {
    permissions = ["reservations.read"];
    renderHeader();
    expect(screen.getByText("Front Office")).toBeInTheDocument();
  });
  it("offers purchase request, budget and approval settings navigation only for their own rights", () => {
    permissions = ["purchaserequests.read"];
    const view = renderHeader();
    expect(screen.getByRole("link", { name: "Purchase Requests" })).toHaveAttribute("href", "/purchase-requests");
    expect(screen.queryByRole("link", { name: "Purchase budgets" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Purchasing & Inventory Settings" })).not.toBeInTheDocument();
    view.unmount(); permissions = ["purchasebudgets.read", "purchasebudgets.settings"]; renderHeader();
    expect(screen.getByRole("link", { name: "Purchase budgets" })).toHaveAttribute("href", "/purchase-budgets");
    expect(screen.getByRole("link", { name: "Purchasing & Inventory Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Purchase Requests" })).not.toBeInTheDocument();
  });
  it("keeps catalog sync within Catalog Products instead of adding a separate menu item", () => {
    permissions = ["catalogproducts.read", "supplierproducts.read", "supplierproducts.update", "suppliers.read"];
    renderHeader();
    expect(screen.getByRole("link", { name: "Catalog Products" })).toHaveAttribute("href", "/catalog/products");
    expect(screen.getByRole("link", { name: "Supplier Products" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Catalog sync" })).not.toBeInTheDocument();
  });
  it("shows movement navigation only for its separate read permission", () => {
    permissions = ["stockcounts.read"];
    const page = renderHeader();
    expect(screen.queryByRole("link", { name: "Inventory movements" })).not.toBeInTheDocument();
    page.unmount();
    permissions = ["inventorymovements.read"];
    renderHeader();
    expect(screen.getByRole("link", { name: "Inventory movements" })).toHaveAttribute("href", "/catalog/inventory-movements");
  });
  it.each(["catalogsettings.read", "outlets.read", "locations.read"])("offers one module settings link for %s", (permission) => {
    permissions = [permission];
    renderHeader();
    expect(screen.getByRole("link", { name: "Purchasing & Inventory Settings" })).toHaveAttribute("href", "/settings/procurement");
    expect(screen.queryByRole("link", { name: "Catalog Settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Outlet Settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Location Settings" })).not.toBeInTheDocument();
  });
  it("does not expose a module settings link for creation authority alone", () => {
    permissions = ["outlets.create", "locations.create", "catalogsettings.create"];
    renderHeader();
    expect(screen.queryByRole("link", { name: "Purchasing & Inventory Settings" })).not.toBeInTheDocument();
  });
  it("exposes mapping settings only with both supplier and supplier-product read rights", () => {
    permissions = ["suppliers.read", "supplierproducts.read"]; const view = renderHeader();
    expect(screen.getByRole("link", { name: "Purchasing & Inventory Settings" })).toBeInTheDocument(); view.unmount();
    permissions = ["supplierproducts.read"]; renderHeader();
    expect(screen.queryByRole("link", { name: "Purchasing & Inventory Settings" })).not.toBeInTheDocument();
  });
});
