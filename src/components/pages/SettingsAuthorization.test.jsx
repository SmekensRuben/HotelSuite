import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SettingsCatalogPage from "./SettingsCatalogPage";
import ContractSettingsPage from "./ContractSettingsPage";

const mocks = vi.hoisted(() => ({
  permissions: new Set(),
  hotelUid: "hotel-a",
  getCatalogTaxonomy: vi.fn(), getContractTaxonomy: vi.fn(),
  createCatalogCategory: vi.fn(), updateCatalogCategory: vi.fn(), deleteCatalogCategory: vi.fn(),
  createCatalogSubcategory: vi.fn(), updateCatalogSubcategory: vi.fn(), deleteCatalogSubcategory: vi.fn(),
  createContractCategory: vi.fn(), updateContractCategory: vi.fn(), deleteContractCategory: vi.fn(),
  createContractSubcategory: vi.fn(), updateContractSubcategory: vi.fn(), deleteContractSubcategory: vi.fn(),
}));
vi.mock("../../services/firebaseSettings", () => mocks);
vi.mock("../../firebaseConfig", () => ({ auth: {}, signOut: vi.fn() }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: (feature, action) => mocks.permissions.has(`${feature}.${action}`) }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotelUid }) }));
vi.mock("../layout/HeaderBar", () => ({ default: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.permissions.clear();
  mocks.hotelUid = "hotel-a";
  mocks.getCatalogTaxonomy.mockResolvedValue({ categories: [], subcategories: [] });
  mocks.getContractTaxonomy.mockResolvedValue({ categories: [], subcategories: [] });
});
afterEach(cleanup);

it("requires contracts.settings for every contract taxonomy mutation", async () => {
  mocks.permissions.add("contracts.create");
  mocks.permissions.add("contracts.update");
  mocks.permissions.add("contracts.delete");
  const view = render(<ContractSettingsPage />);
  await screen.findByText("No categories yet.");
  expect(screen.getByRole("button", { name: "Add category", exact: true })).toBeDisabled();
  mocks.permissions.add("contracts.settings");
  view.rerender(<ContractSettingsPage />);
  expect(screen.getByRole("button", { name: "Add category", exact: true })).toBeEnabled();
  fireEvent.change(screen.getByPlaceholderText("New category"), { target: { value: "Service contracts" } });
  fireEvent.click(screen.getByRole("button", { name: "Add category", exact: true }));
  await waitFor(() => expect(mocks.createContractCategory).toHaveBeenCalledWith("hotel-a", { name: "Service contracts" }));
});

it("uses catalog create authority without rewriting the loaded taxonomy", async () => {
  mocks.permissions.add("catalogsettings.create");
  mocks.getCatalogTaxonomy.mockResolvedValueOnce({ categories: [{ id: "existing", name: "Existing" }], subcategories: [] })
    .mockResolvedValue({ categories: [{ id: "existing", name: "Existing" }, { id: "concurrent", name: "Concurrent operator" }, { id: "new", name: "New" }], subcategories: [] });
  render(<SettingsCatalogPage />);
  await screen.findByText("Existing", { selector: "span" });
  expect(screen.queryByRole("button", { name: "Edit", exact: true })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Delete", exact: true })).not.toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText("New category"), { target: { value: "New" } });
  fireEvent.click(screen.getByRole("button", { name: "Add category", exact: true }));
  await waitFor(() => expect(mocks.createCatalogCategory).toHaveBeenCalledWith("hotel-a", { name: "New" }));
  await screen.findByText("Concurrent operator", { selector: "span" });
  expect(mocks.updateCatalogCategory).not.toHaveBeenCalled();
  expect(mocks.deleteCatalogCategory).not.toHaveBeenCalled();
});

it("recovers a settings load failure through an explicit retry", async () => {
  mocks.getCatalogTaxonomy.mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValue({ categories: [{ id: "recovered", name: "Recovered" }], subcategories: [] });
  render(<SettingsCatalogPage />);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Reload settings" }));
  await screen.findByText("Recovered", { selector: "span" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("acknowledges a saved create when only the subsequent refresh fails", async () => {
  mocks.permissions.add("catalogsettings.create");
  mocks.getCatalogTaxonomy.mockResolvedValueOnce({ categories: [], subcategories: [] })
    .mockRejectedValueOnce(new Error("unavailable"));
  render(<SettingsCatalogPage />);
  await screen.findByText("No categories yet.");
  fireEvent.change(screen.getByPlaceholderText("New category"), { target: { value: "Saved category" } });
  fireEvent.click(screen.getByRole("button", { name: "Add category", exact: true }));
  await screen.findByText(/Changes saved, but settings could not be refreshed/);
  expect(screen.getByPlaceholderText("New category")).toHaveValue("");
  expect(mocks.createCatalogCategory).toHaveBeenCalledTimes(1);
});

it("ignores an earlier hotel's response after switching hotels", async () => {
  let resolveOld;
  mocks.getCatalogTaxonomy.mockImplementation((hotelUid) => hotelUid === "hotel-a"
    ? new Promise((resolve) => { resolveOld = resolve; })
    : Promise.resolve({ categories: [{ id: "new-hotel", name: "New hotel category" }], subcategories: [] }));
  const view = render(<SettingsCatalogPage />);
  mocks.hotelUid = "hotel-b";
  view.rerender(<SettingsCatalogPage />);
  await screen.findByText("New hotel category", { selector: "span" });
  resolveOld({ categories: [{ id: "old-hotel", name: "Old hotel category" }], subcategories: [] });
  await waitFor(() => expect(screen.queryByText("Old hotel category")).not.toBeInTheDocument());
  expect(screen.getByText("New hotel category", { selector: "span" })).toBeInTheDocument();
});

it("clears an edit from the previous hotel even when category IDs are reused", async () => {
  mocks.permissions.add("catalogsettings.update");
  mocks.getCatalogTaxonomy.mockImplementation(async (hotelUid) => ({ categories: [{ id: "shared-id", name: hotelUid === "hotel-a" ? "First category" : "Second category" }], subcategories: [] }));
  const view = render(<SettingsCatalogPage />);
  await screen.findByText("First category", { selector: "span" });
  fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
  expect(screen.getByDisplayValue("First category")).toBeInTheDocument();
  mocks.hotelUid = "hotel-b";
  view.rerender(<SettingsCatalogPage />);
  await screen.findByText("Second category", { selector: "span" });
  expect(screen.queryByRole("button", { name: "Save", exact: true })).not.toBeInTheDocument();
  expect(mocks.updateCatalogCategory).not.toHaveBeenCalled();
});
