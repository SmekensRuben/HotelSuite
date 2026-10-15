import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ load: vi.fn(), assign: vi.fn(), pending: vi.fn(), retry: vi.fn(), current: true, onAssigned: vi.fn(), settingsLoad: vi.fn() }));
vi.mock("../../services/firebaseProducts", () => ({ getCatalogProducts: mocks.load }));
vi.mock("../../services/firebaseCatalogSkuAssignments", () => ({ assignCatalogSkus: mocks.assign, getPendingCatalogSkuAssignment: mocks.pending, retryCatalogSkuAssignment: mocks.retry }));
vi.mock("../../hooks/useProcurementSettingsScope", () => ({ useProcurementSettingsScope: () => ({ hotelUid: "hotel-a", scopeKey: "hotel-a:manager:one", current: () => mocks.current }) }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: () => true }));
vi.mock("../../services/firebaseCatalogSkuSettings", () => ({ getCatalogSkuSettings: mocks.settingsLoad, getPendingCatalogSkuSettings: () => null,
  saveCatalogSkuSettings: vi.fn(), retryCatalogSkuSettings: vi.fn(), normalizeCatalogSkuSettings: ({ enabled, prefix, padding, nextNumber }) => ({ enabled, prefix, padding, nextNumber }) }));
import CatalogSkuBackfillPanel from "./CatalogSkuBackfillPanel";
import CatalogSkuSettingsSection from "../pages/CatalogSkuSettingsSection";
const settings = { hotelUid: "hotel-a", revision: 4, enabled: true, prefix: "CAT-", padding: 6, nextNumber: 17 };
const sourceRows = [{ id: "milk", name: "Milk bottle", baseUnit: "l", revision: 2 }, { id: "water", name: "Water bottle", baseUnit: "l", internalSku: "  " },
  { id: "existing", name: "Already numbered", baseUnit: "kg", internalSku: "MANUAL-1" }, { id: "archived", name: "Archived blank", archived: true },
  { id: "archived-time", name: "Previously archived blank", archivedAt: { seconds: 123 } }, { id: "numeric", name: "Malformed numeric SKU", internalSku: 0 }];
const scope = (patch = {}) => ({ hotelUid: "hotel-a", scopeKey: "hotel-a:manager:one", current: () => mocks.current, ...patch });
const assigned = { hotelUid: "hotel-a", requestId: "original", settingsRevision: 5, assigned: [{ productId: "milk", revision: 3, internalSku: "CAT-000017" }] };
const view = (props = {}) => render(<CatalogSkuBackfillPanel scope={scope()} settings={settings} onAssigned={mocks.onAssigned} {...props} />);
beforeEach(() => { vi.clearAllMocks(); mocks.current = true; mocks.load.mockResolvedValue({ products: sourceRows, cursor: null, hasMore: false }); mocks.pending.mockReturnValue(null); mocks.assign.mockResolvedValue(assigned); mocks.retry.mockResolvedValue(assigned); mocks.onAssigned.mockResolvedValue(); });
it("loads only on demand, lists genuine missing non-archived SKUs and assigns only the explicit selection", async () => {
  view(); expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.assign).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Review products without SKUs" }));
  await screen.findByRole("checkbox", { name: /Milk bottle/ });
  expect(mocks.load).toHaveBeenCalledWith("hotel-a", { pageSize: 25, cursor: null });
  expect(screen.getAllByRole("checkbox")).toHaveLength(2); expect(screen.queryByText("Already numbered")).not.toBeInTheDocument();
  expect(screen.queryByText("Archived blank")).not.toBeInTheDocument(); expect(screen.queryByText("Previously archived blank")).not.toBeInTheDocument(); expect(screen.queryByText("Malformed numeric SKU")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Assign SKUs to 0 selected products" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: /Milk bottle/ }));
  fireEvent.click(screen.getByRole("button", { name: "Assign SKUs to 1 selected products" }));
  await waitFor(() => expect(mocks.assign).toHaveBeenCalledWith("hotel-a", { expectedSettingsRevision: 4, products: [{ productId: "milk", expectedRevision: 2 }] }));
  await screen.findByText("1 internal SKUs assigned. Product identities and recorded history are preserved.");
  expect(mocks.onAssigned).toHaveBeenCalledTimes(1); expect(screen.getByRole("button", { name: "Assign SKUs to 0 selected products" })).toBeDisabled();
});
it("treats a missing legacy product revision as zero without selecting other products", async () => {
  view(); fireEvent.click(screen.getByRole("button", { name: "Review products without SKUs" })); await screen.findByRole("checkbox", { name: /Water bottle/ });
  fireEvent.click(screen.getByRole("checkbox", { name: /Water bottle/ })); fireEvent.click(screen.getByRole("button", { name: "Assign SKUs to 1 selected products" }));
  await waitFor(() => expect(mocks.assign).toHaveBeenCalledWith("hotel-a", { expectedSettingsRevision: 4, products: [{ productId: "water", expectedRevision: 0 }] }));
});
it("uses the actual opaque Firestore cursor without serializing its circular internals and clears selections between bounded pages", async () => {
  const cursor = { id: "milk", ref: { path: "hotels/hotel-a/catalogproducts/milk" } }; cursor.self = cursor;
  mocks.load.mockResolvedValueOnce({ products: sourceRows, cursor, hasMore: true }).mockResolvedValueOnce({ products: [{ id: "tea", name: "Tea tin", baseUnit: "kg", revision: 7 }], cursor: null, hasMore: false });
  view(); fireEvent.click(screen.getByRole("button", { name: "Review products without SKUs" })); await screen.findByRole("checkbox", { name: /Milk bottle/ });
  fireEvent.click(screen.getByRole("checkbox", { name: /Milk bottle/ })); fireEvent.click(screen.getByRole("button", { name: "Next catalog page" }));
  await screen.findByRole("checkbox", { name: /Tea tin/ });
  expect(mocks.load).toHaveBeenNthCalledWith(2, "hotel-a", { pageSize: 25, cursor });
  expect(screen.getByRole("button", { name: "Assign SKUs to 0 selected products" })).toBeDisabled(); expect(screen.queryByRole("checkbox", { name: /Milk bottle/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "First catalog page" })); await screen.findByRole("checkbox", { name: /Milk bottle/ });
  expect(mocks.load).toHaveBeenLastCalledWith("hotel-a", { pageSize: 25, cursor: null }); expect(mocks.assign).not.toHaveBeenCalled();
});
it("recovers an unknown original command after remount without loading a new selection or using changed settings", async () => {
  mocks.pending.mockReturnValue({ requestId: "immutable-request", expectedSettingsRevision: 4, products: [{ productId: "milk", expectedRevision: 2 }] });
  view({ settings: { ...settings, revision: 19, prefix: "NEW-", nextNumber: 80, enabled: false } });
  expect(await screen.findByRole("button", { name: "Verify original SKU assignment" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Review products without SKUs" })).toBeDisabled(); expect(mocks.load).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Verify original SKU assignment" }));
  await waitFor(() => expect(mocks.retry).toHaveBeenCalledWith("hotel-a"));
  await screen.findByText("1 internal SKUs assigned. Product identities and recorded history are preserved."); expect(mocks.assign).not.toHaveBeenCalled(); expect(mocks.onAssigned).toHaveBeenCalledTimes(1);
});
it("preserves an uncertain selection and exposes only original replay after an interrupted response", async () => {
  const pending = { requestId: "immutable-request", expectedSettingsRevision: 4, products: [{ productId: "milk", expectedRevision: 2 }] };
  mocks.assign.mockImplementationOnce(async () => { mocks.pending.mockReturnValue(pending); throw new Error("Acknowledgment lost"); });
  view(); fireEvent.click(screen.getByRole("button", { name: "Review products without SKUs" })); await screen.findByRole("checkbox", { name: /Milk bottle/ });
  fireEvent.click(screen.getByRole("checkbox", { name: /Milk bottle/ })); fireEvent.click(screen.getByRole("button", { name: "Assign SKUs to 1 selected products" }));
  await screen.findByText("Acknowledgment lost"); expect(screen.getByRole("checkbox", { name: /Water bottle/ })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Verify original SKU assignment" }));
  await waitFor(() => expect(mocks.retry).toHaveBeenCalledWith("hotel-a")); expect(mocks.assign).toHaveBeenCalledTimes(1);
});
it("refreshes stale settings and products only after the server proves the original command uncommitted", async () => {
  const failure = Object.assign(new Error("The settings changed before assignment"), { code: "aborted", details: { catalogSkuRequestUncommitted: true } });
  mocks.assign.mockRejectedValueOnce(failure);
  view(); fireEvent.click(screen.getByRole("button", { name: "Review products without SKUs" })); await screen.findByRole("checkbox", { name: /Milk bottle/ });
  fireEvent.click(screen.getByRole("checkbox", { name: /Milk bottle/ })); fireEvent.click(screen.getByRole("button", { name: "Assign SKUs to 1 selected products" }));
  await screen.findByText("The settings changed before assignment"); await waitFor(() => expect(mocks.onAssigned).toHaveBeenCalledTimes(1));
  expect(mocks.load).toHaveBeenCalledTimes(2); expect(screen.queryByRole("button", { name: "Verify original SKU assignment" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Assign SKUs to 0 selected products" })).toBeDisabled();
});
it("locks assignment while settings are dirty or numbering is disabled, and never invents a pending command from corrupted storage", async () => {
  const first = view({ locked: true }); expect(screen.getByRole("button", { name: "Review products without SKUs" })).toBeDisabled(); expect(mocks.load).not.toHaveBeenCalled(); first.unmount();
  const second = view({ settings: { ...settings, enabled: false } }); expect(screen.getByRole("button", { name: "Review products without SKUs" })).toBeDisabled(); second.unmount();
  mocks.pending.mockImplementationOnce(() => { throw new Error("The original SKU assignment could not be verified"); }); view();
  await screen.findByText("The original SKU assignment could not be verified"); expect(screen.getByRole("button", { name: "Review products without SKUs" })).toBeDisabled(); expect(mocks.assign).not.toHaveBeenCalled();
});
it("discards a late assignment notice and callback after the actor or hotel scope changes", async () => {
  let resolve;
  mocks.assign.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const displayed = view(); fireEvent.click(screen.getByRole("button", { name: "Review products without SKUs" })); await screen.findByRole("checkbox", { name: /Milk bottle/ });
  fireEvent.click(screen.getByRole("checkbox", { name: /Milk bottle/ })); fireEvent.click(screen.getByRole("button", { name: "Assign SKUs to 1 selected products" }));
  await waitFor(() => expect(mocks.assign).toHaveBeenCalledTimes(1));
  displayed.rerender(<CatalogSkuBackfillPanel scope={scope({ hotelUid: "hotel-b", scopeKey: "hotel-b:other:one" })} settings={{ ...settings, hotelUid: "hotel-b" }} onAssigned={mocks.onAssigned} />);
  await act(async () => resolve(assigned));
  expect(screen.queryByText("1 internal SKUs assigned. Product identities and recorded history are preserved.")).not.toBeInTheDocument();
  expect(mocks.onAssigned).not.toHaveBeenCalled(); expect(screen.getByRole("button", { name: "Review products without SKUs" })).toBeEnabled();
});
it("keeps the real settings parent mounted during counter refresh so the assignment notice survives", async () => {
  let finishSettings;
  mocks.settingsLoad.mockResolvedValueOnce({ ...settings, policyVersion: 1 }).mockReturnValueOnce(new Promise((resolve) => { finishSettings = resolve; }));
  render(<CatalogSkuSettingsSection />); await screen.findByText("CAT-000017");
  fireEvent.click(screen.getByRole("button", { name: "Review products without SKUs" })); await screen.findByRole("checkbox", { name: /Milk bottle/ });
  fireEvent.click(screen.getByRole("checkbox", { name: /Milk bottle/ })); fireEvent.click(screen.getByRole("button", { name: "Assign SKUs to 1 selected products" }));
  await screen.findByText("1 internal SKUs assigned. Product identities and recorded history are preserved.");
  await waitFor(() => expect(mocks.settingsLoad).toHaveBeenCalledTimes(2));
  expect(screen.getByText("1 internal SKUs assigned. Product identities and recorded history are preserved.")).toBeInTheDocument();
  await act(async () => finishSettings({ ...settings, policyVersion: 1, revision: 5, nextNumber: 18 }));
  await screen.findByText("CAT-000018"); expect(screen.getByText("1 internal SKUs assigned. Product identities and recorded history are preserved.")).toBeInTheDocument();
  expect(mocks.pending).toHaveBeenCalledTimes(1);
});
