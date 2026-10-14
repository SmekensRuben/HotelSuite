import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SupplierImportMappingSettingsSection from "./SupplierImportMappingSettingsSection";
const mocks = vi.hoisted(() => ({ hotel: "hotel-a", scope: "scope-a", directory: vi.fn(), read: vi.fn(), save: vi.fn(), current: () => true }));
vi.mock("../../hooks/useProcurementSettingsScope", () => ({ useProcurementSettingsScope: () => ({ hotelUid: mocks.hotel, scopeKey: mocks.scope, current: mocks.current }) }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: () => true }));
vi.mock("../../services/firebaseSuppliers", () => ({ getSuppliers: (...args) => mocks.directory(...args) }));
vi.mock("../../services/firebaseSupplierImportWorkspace", () => ({ readSupplierPurchaseUnitMappings: (...args) => mocks.read(...args), saveSupplierPurchaseUnitMappings: (...args) => mocks.save(...args), applySupplierImportMapping: vi.fn() }));
const page = (query = "") => <MemoryRouter initialEntries={[`/settings/procurement?section=supplier-imports${query}`]}><SupplierImportMappingSettingsSection /></MemoryRouter>;
beforeEach(() => {
  vi.clearAllMocks(); mocks.hotel = "hotel-a"; mocks.scope = "scope-a";
  mocks.directory.mockResolvedValue([{ id: "supplier", name: "Fictional supplier" }, { id: "closed", name: "Archived supplier", archived: true }]);
  mocks.read.mockImplementation(async (_, supplierId, sourceFormat) => ({ version: 1, supplierId, sourceFormat, profileId: "default", revision: 1, mappings: [{ sourceUnit: sourceFormat === "xlsx" ? "BK" : "ZZ", purchaseUnit: "Box" }], suggestions: [] }));
});
afterEach(cleanup);
it("requires a supplier choice, uses an English searchable selector and hides archived suppliers", async () => {
  render(page()); await screen.findByText("Select a supplier to manage its purchase-unit mappings.");
  expect(mocks.read).not.toHaveBeenCalled();
  fireEvent.focus(screen.getByRole("combobox", { name: "Mapping supplier" }));
  expect(screen.queryByRole("option", { name: "Archived supplier" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("option", { name: "Fictional supplier" }));
  await screen.findByText("BK");
  expect(mocks.read).toHaveBeenCalledWith("hotel-a", "supplier", "xlsx", "default");
  fireEvent.change(screen.getByRole("combobox", { name: "Mapping file format" }), { target: { value: "csv" } });
  await screen.findByText("ZZ");
  expect(screen.queryByText("BK")).not.toBeInTheDocument();
  expect(mocks.read).toHaveBeenLastCalledWith("hotel-a", "supplier", "csv", "default");
});
it("resolves a review deep link only against the current hotel's supplier directory", async () => {
  render(page("&supplier=foreign-hotel-supplier&format=pdf"));
  await screen.findByText("Select a supplier to manage its purchase-unit mappings.");
  expect(screen.getByRole("combobox", { name: "Mapping file format" })).toHaveValue("pdf");
  expect(mocks.read).not.toHaveBeenCalled();
});
it("clears a former hotel's selected supplier immediately and ignores its late directory response", async () => {
  let resolve; mocks.directory.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const view = render(page("&supplier=supplier"));
  await waitFor(() => expect(mocks.directory).toHaveBeenCalledTimes(1));
  mocks.hotel = "hotel-b"; mocks.scope = "scope-b";
  mocks.directory.mockResolvedValue([{ id: "new", name: "New hotel supplier" }]);
  view.rerender(page("&supplier=supplier"));
  await screen.findByText("Select a supplier to manage its purchase-unit mappings.");
  await act(async () => resolve([{ id: "supplier", name: "Old hotel private supplier" }]));
  fireEvent.focus(screen.getByRole("combobox", { name: "Mapping supplier" }));
  expect(screen.queryByText("Old hotel private supplier")).not.toBeInTheDocument();
  expect(screen.getByRole("option", { name: "New hotel supplier" })).toBeInTheDocument();
  expect(mocks.read).not.toHaveBeenCalled();
});
it("discards a stale profile after switching formats and resets unsaved package-code edits", async () => {
  let resolve; mocks.read.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  render(page("&supplier=supplier")); await waitFor(() => expect(mocks.read).toHaveBeenCalled());
  fireEvent.change(screen.getByRole("combobox", { name: "Mapping file format" }), { target: { value: "csv" } });
  await screen.findByText("ZZ");
  fireEvent.change(screen.getByRole("textbox", { name: "Source package code" }), { target: { value: "Old CSV draft" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Mapping file format" }), { target: { value: "pdf" } });
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Source package code" })).toHaveValue(""));
  await act(async () => resolve({ revision: 1, mappings: [{ sourceUnit: "PRIVATE XLSX CODE", purchaseUnit: "Box" }], suggestions: [] }));
  expect(screen.queryByText("PRIVATE XLSX CODE")).not.toBeInTheDocument(); expect(mocks.save).not.toHaveBeenCalled();
});
it("keeps failed supplier directory reads explicit and supports a fresh retry", async () => {
  mocks.directory.mockRejectedValueOnce(new Error("Private unavailable directory")); render(page());
  await screen.findByRole("alert"); expect(mocks.read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Retry supplier directory" }));
  await screen.findByText("Select a supplier to manage its purchase-unit mappings.");
  expect(mocks.directory).toHaveBeenCalledTimes(2);
});
