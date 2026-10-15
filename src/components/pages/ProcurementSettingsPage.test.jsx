import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProcurementSettingsPage from "./ProcurementSettingsPage";

const mocks = vi.hoisted(() => ({
  hotelUid: "hotel-a", actor: { uid: "actor-a" }, permissions: new Set(),
  taxonomy: vi.fn(), outlets: vi.fn(), locations: vi.fn(), suppliers: vi.fn(), mappings: vi.fn(),
  createCatalogCategory: vi.fn(), updateCatalogCategory: vi.fn(), deleteCatalogCategory: vi.fn(),
  createCatalogSubcategory: vi.fn(), updateCatalogSubcategory: vi.fn(), deleteCatalogSubcategory: vi.fn(),
  purchaseSettings: vi.fn(),
}));
vi.mock("../../firebaseConfig", () => ({ auth: { get currentUser() { return mocks.actor; } }, signOut: vi.fn() }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotelUid,
  permissions: [...mocks.permissions], subscriptionActive: true, subscription: { modules: ["procurement"] } }) }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: (feature, action) => mocks.permissions.has(`${feature}.${action}`) }));
vi.mock("../../services/firebaseSettings", () => ({
  getCatalogTaxonomy: mocks.taxonomy, getOutlets: mocks.outlets, getLocations: mocks.locations,
  createCatalogCategory: mocks.createCatalogCategory, updateCatalogCategory: mocks.updateCatalogCategory, deleteCatalogCategory: mocks.deleteCatalogCategory,
  createCatalogSubcategory: mocks.createCatalogSubcategory, updateCatalogSubcategory: mocks.updateCatalogSubcategory, deleteCatalogSubcategory: mocks.deleteCatalogSubcategory,
}));
vi.mock("../../services/firebaseSuppliers", () => ({ getSuppliers: mocks.suppliers }));
vi.mock("../../services/firebaseSupplierImportWorkspace", () => ({ readSupplierPurchaseUnitMappings: mocks.mappings, saveSupplierPurchaseUnitMappings: vi.fn(), applySupplierImportMapping: vi.fn() }));
vi.mock("../layout/HeaderBar", () => ({ default: () => <div data-testid="workspace-header" /> }));
vi.mock("./PurchaseRequestSettingsSection", () => ({ default: () => { mocks.purchaseSettings(); return <p>Purchase approval configuration</p>; } }));
function CurrentUrl() { const { pathname, search } = useLocation(); return <output data-testid="url">{pathname}{search}</output>; }
const page = (section = "categories") => <MemoryRouter initialEntries={[`/settings/procurement?section=${section}`]}><CurrentUrl /><ProcurementSettingsPage /></MemoryRouter>;
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hotelUid = "hotel-a";
  mocks.actor = { uid: "actor-a" };
  mocks.permissions = new Set(["catalogsettings.read", "outlets.read", "locations.read"]);
  mocks.taxonomy.mockResolvedValue({ categories: [{ id: "drinks", name: "Drinks" }], subcategories: [] });
  mocks.outlets.mockResolvedValue([{ id: "bar", name: "Lobby bar" }, { id: "closed", name: "Closed restaurant", archived: true }]);
  mocks.locations.mockResolvedValue([{ id: "store", name: "Cold room" }]);
  mocks.suppliers.mockResolvedValue([{ id: "supplier", name: "Fictional supplier" }]);
  mocks.mappings.mockResolvedValue({ revision: 0, mappings: [], suggestions: [] });
});
afterEach(cleanup);

describe("one permitted procurement settings section", () => {
  it("opens approval configuration with its explicit right without loading unrelated hotel settings", async () => {
    mocks.permissions = new Set(["purchasebudgets.settings"]);
    render(page("purchase-requests"));
    expect(await screen.findByText("Purchase approval configuration")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Purchase Requests" })).toHaveAttribute("aria-current", "page");
    expect(mocks.taxonomy).not.toHaveBeenCalled(); expect(mocks.outlets).not.toHaveBeenCalled(); expect(mocks.locations).not.toHaveBeenCalled();
  });
  it("offers supplier mappings to users with both read rights without granting unrelated settings", async () => {
    mocks.permissions = new Set(["suppliers.read", "supplierproducts.read"]);
    render(page("supplier-imports"));
    await screen.findByRole("combobox", { name: "Mapping supplier" });
    expect(mocks.suppliers).toHaveBeenCalledWith("hotel-a");
    expect(screen.queryByRole("link", { name: "Categories" })).not.toBeInTheDocument();
    fireEvent.focus(screen.getByRole("combobox", { name: "Mapping supplier" }));
    fireEvent.click(screen.getByRole("option", { name: "Fictional supplier" }));
    await screen.findByText("No saved mappings for this supplier and file format.");
    expect(screen.getByRole("button", { name: "Save mapping for future imports" })).toBeDisabled();
    expect(mocks.taxonomy).not.toHaveBeenCalled(); expect(mocks.locations).not.toHaveBeenCalled();
  });
  it.each(["suppliers.read", "supplierproducts.read"])("never mounts mapping reads with only %s", (permission) => {
    mocks.permissions = new Set([permission]); render(page("supplier-imports"));
    expect(screen.queryByRole("link", { name: "Supplier import mappings" })).not.toBeInTheDocument();
    expect(mocks.suppliers).not.toHaveBeenCalled(); expect(mocks.mappings).not.toHaveBeenCalled();
  });
  it("uses one workspace header and fetches only the chosen section, then exposes keyboard-accessible detail links", async () => {
    render(page());
    await screen.findByText("Drinks", { selector: "span" });
    expect(screen.getAllByTestId("workspace-header")).toHaveLength(1);
    expect(mocks.taxonomy).toHaveBeenCalledTimes(1);
    expect(mocks.outlets).not.toHaveBeenCalled();
    expect(mocks.locations).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("link", { name: "Outlets" }));
    expect(await screen.findByRole("link", { name: "Lobby bar" })).toHaveAttribute("href", "/settings/outlets/bar");
    expect(screen.queryByText("Drinks")).not.toBeInTheDocument();
    expect(mocks.outlets).toHaveBeenCalledTimes(1);
    expect(mocks.locations).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Add Outlet" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show archived" }));
    expect(screen.getByRole("link", { name: "Closed restaurant" })).toBeInTheDocument();
  });

  it("selects an allowed section before mounting when the requested section is forbidden", async () => {
    mocks.permissions = new Set(["locations.read", "outlets.create"]);
    render(page("outlets"));
    await screen.findByRole("link", { name: "Cold room" });
    expect(screen.getByTestId("url")).toHaveTextContent("/settings/procurement?section=locations");
    expect(screen.queryByRole("link", { name: "Outlets" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Categories" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Location" })).not.toBeInTheDocument();
    expect(mocks.outlets).not.toHaveBeenCalled();
    expect(mocks.taxonomy).not.toHaveBeenCalled();
    expect(mocks.locations).toHaveBeenCalledTimes(1);
  });

  it("keeps section creation authority separate from other sections", async () => {
    mocks.permissions.add("outlets.create");
    render(page("outlets"));
    expect(await screen.findByRole("button", { name: "Add Outlet" })).toBeEnabled();
    fireEvent.click(screen.getByRole("link", { name: "Locations & templates" }));
    await screen.findByRole("link", { name: "Cold room" });
    expect(screen.queryByRole("button", { name: "Add Location" })).not.toBeInTheDocument();
  });

  it("never loads module settings without any section's read permission", () => {
    mocks.permissions = new Set(["outlets.create", "locations.update"]);
    render(page());
    expect(screen.getByRole("alert")).toHaveTextContent("do not have access");
    expect(mocks.taxonomy).not.toHaveBeenCalled();
    expect(mocks.outlets).not.toHaveBeenCalled();
    expect(mocks.locations).not.toHaveBeenCalled();
  });

  it("discards a pending old actor response and resets drafts even when the replacement actor uses the same UID", async () => {
    const old = deferred();
    mocks.taxonomy.mockReturnValueOnce(old.promise).mockResolvedValue({ categories: [{ id: "fresh", name: "New actor category" }], subcategories: [] });
    const view = render(page());
    await waitFor(() => expect(mocks.taxonomy).toHaveBeenCalledTimes(1));
    mocks.actor = { uid: "actor-a" };
    view.rerender(page());
    await screen.findByText("New actor category", { selector: "span" });
    await act(async () => old.resolve({ categories: [{ id: "obsolete", name: "Old actor category" }], subcategories: [] }));
    expect(screen.queryByText("Old actor category")).not.toBeInTheDocument();
    expect(mocks.taxonomy).toHaveBeenCalledTimes(2);
  });

  it("clears a taxonomy draft on a hotel switch and rejects obsolete results", async () => {
    mocks.permissions.add("catalogsettings.create");
    const view = render(page());
    await screen.findByText("Drinks", { selector: "span" });
    fireEvent.change(screen.getByPlaceholderText("New category"), { target: { value: "Old hotel draft" } });
    mocks.hotelUid = "hotel-b";
    mocks.taxonomy.mockResolvedValue({ categories: [{ id: "food", name: "New hotel food" }], subcategories: [] });
    view.rerender(page());
    await screen.findByText("New hotel food", { selector: "span" });
    expect(screen.getByPlaceholderText("New category")).toHaveValue("");
    expect(screen.queryByText("Drinks")).not.toBeInTheDocument();
    expect(mocks.createCatalogCategory).not.toHaveBeenCalled();
    expect(mocks.taxonomy).toHaveBeenLastCalledWith("hotel-b");
  });

  it("removes a revoked panel immediately and never exposes its late privileged response", async () => {
    const old = deferred();
    mocks.taxonomy.mockReturnValue(old.promise);
    const view = render(page());
    await waitFor(() => expect(mocks.taxonomy).toHaveBeenCalledTimes(1));
    mocks.permissions = new Set(["outlets.read"]);
    view.rerender(page());
    expect(screen.queryByRole("heading", { name: "Categories & subcategories" })).not.toBeInTheDocument();
    await screen.findByRole("link", { name: "Lobby bar" });
    await act(async () => old.resolve({ categories: [{ id: "hidden", name: "Revoked private category" }], subcategories: [] }));
    expect(screen.queryByText("Revoked private category")).not.toBeInTheDocument();
    expect(screen.getByTestId("url")).toHaveTextContent("section=outlets");
    expect(mocks.locations).not.toHaveBeenCalled();
  });
  it("unmounts a pending revoked outlet panel before loading the allowed category fallback", async () => {
    const old = deferred();
    mocks.outlets.mockReturnValue(old.promise);
    const view = render(page("outlets"));
    await waitFor(() => expect(mocks.outlets).toHaveBeenCalledTimes(1));
    expect(mocks.taxonomy).not.toHaveBeenCalled();
    mocks.permissions = new Set(["catalogsettings.read"]);
    view.rerender(page("outlets"));
    expect(screen.queryByRole("heading", { name: "Outlets & approvers" })).not.toBeInTheDocument();
    await screen.findByText("Drinks", { selector: "span" });
    await act(async () => old.resolve([{ id: "private", name: "Revoked outlet" }]));
    expect(screen.queryByText("Revoked outlet")).not.toBeInTheDocument();
    expect(mocks.taxonomy).toHaveBeenCalledTimes(1);
    expect(mocks.locations).not.toHaveBeenCalled();
  });
});
