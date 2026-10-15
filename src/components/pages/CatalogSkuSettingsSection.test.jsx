import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ hotelUid: "hotel-a", actor: { uid: "manager" }, rights: new Set(), load: vi.fn(), save: vi.fn(), pending: vi.fn(), retry: vi.fn() }));
vi.mock("../../firebaseConfig", () => ({ auth: { get currentUser() { return mocks.actor; } } }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotelUid, permissions: [...mocks.rights], subscriptionActive: true }) }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: (feature, action) => mocks.rights.has(`${feature}.${action}`) }));
vi.mock("../../services/firebaseCatalogSkuSettings", () => ({ getCatalogSkuSettings: mocks.load, saveCatalogSkuSettings: mocks.save, getPendingCatalogSkuSettings: mocks.pending, retryCatalogSkuSettings: mocks.retry,
  normalizeCatalogSkuSettings: ({ enabled, prefix, padding, nextNumber }) => ({ enabled, prefix, padding, nextNumber }) }));
import CatalogSkuSettingsSection from "./CatalogSkuSettingsSection";
const settings = { hotelUid: "hotel-a", policyVersion: 1, revision: 3, enabled: true, prefix: "CAT-", padding: 6, nextNumber: 17 };
beforeEach(() => { vi.clearAllMocks(); mocks.hotelUid = "hotel-a"; mocks.actor = { uid: "manager" }; mocks.rights = new Set(["catalogsettings.read", "catalogsettings.update"]); mocks.load.mockResolvedValue(settings); mocks.pending.mockReturnValue(null); mocks.save.mockResolvedValue(settings); mocks.retry.mockResolvedValue(settings); });
it("shows a useful preview and saves explicit hotel settings with the reviewed revision", async () => {
  render(<CatalogSkuSettingsSection />);
  expect(await screen.findByText("CAT-000017")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("SKU prefix"), { target: { value: "ght-" } });
  expect(screen.getByText("GHT-000017")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save SKU settings" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("hotel-a", { enabled: true, prefix: "GHT-", padding: 6, nextNumber: 17 }, { expectedRevision: 3 }));
});
it("keeps read-only access separate from numbering changes", async () => {
  mocks.rights.delete("catalogsettings.update"); render(<CatalogSkuSettingsSection />);
  await screen.findByText("CAT-000017");
  expect(screen.getByRole("button", { name: "Save SKU settings" })).toBeDisabled();
  expect(screen.getByLabelText("SKU prefix")).toBeDisabled();
});
it("never loads numbering without catalog settings read permission", () => {
  mocks.rights = new Set(["catalogsettings.update"]); render(<CatalogSkuSettingsSection />);
  expect(mocks.load).not.toHaveBeenCalled();
});
it("locks edits while a previous save has an uncertain result and offers exact recovery", async () => {
  mocks.pending.mockReturnValue({ requestId: "original", settings }); render(<CatalogSkuSettingsSection />);
  await screen.findByText("CAT-000017");
  expect(screen.getByLabelText("SKU next number")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Verify original settings save" }));
  await waitFor(() => expect(mocks.retry).toHaveBeenCalledWith("hotel-a"));
  expect(mocks.save).not.toHaveBeenCalled();
});
it("clears drafts on a hotel switch and ignores the previous hotel's late response", async () => {
  let resolveOld;
  mocks.load.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
  const view = render(<CatalogSkuSettingsSection />);
  await waitFor(() => expect(mocks.load).toHaveBeenCalled());
  mocks.hotelUid = "hotel-b"; mocks.load.mockResolvedValue({ ...settings, hotelUid: "hotel-b", prefix: "NEW-" });
  view.rerender(<CatalogSkuSettingsSection />);
  await screen.findByText("NEW-000017");
  await act(async () => resolveOld(settings));
  expect(screen.queryByText("CAT-000017")).not.toBeInTheDocument();
});
