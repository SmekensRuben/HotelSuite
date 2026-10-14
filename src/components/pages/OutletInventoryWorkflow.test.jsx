import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import OutletCreatePage from "./OutletCreatePage";
import OutletEditPage from "./OutletEditPage";
import OutletDetailPage from "./OutletDetailPage";

const mocks = vi.hoisted(() => ({ hotel: "hotel-a", auth: { currentUser: { uid: "operator" } },
  permissions: new Set(), navigate: vi.fn(), create: vi.fn(), update: vi.fn(), outlet: vi.fn(), approvers: vi.fn(), pending: vi.fn(), retry: vi.fn(), users: vi.fn(), setApprovers: vi.fn() }));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate, useParams: () => ({ outletId: "cellar" }) }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotel }) }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: (feature, action) => mocks.permissions.has(`${feature}.${action}`) }));
vi.mock("../../firebaseConfig", () => ({ auth: mocks.auth, signOut: vi.fn() }));
vi.mock("../layout/HeaderBar", () => ({ default: () => null }));
vi.mock("./ProcurementResourceArchive", () => ({ default: () => null }));
vi.mock("../../services/firebaseOnboarding", () => ({ listHotelUsers: mocks.users }));
vi.mock("../../services/firebaseSettings", () => ({ createOutlet: mocks.create, updateOutlet: mocks.update,
  getOutletById: mocks.outlet, getOutletApprovers: mocks.approvers, setOutletApprovers: mocks.setApprovers, getPendingProcurementResourceCommand: mocks.pending, retryPendingProcurementResourceCommand: mocks.retry }));
beforeEach(() => {
  vi.clearAllMocks(); mocks.hotel = "hotel-a"; mocks.auth.currentUser = { uid: "operator" };
  mocks.permissions = new Set(["outlets.create", "outlets.update", "outlets.read", "stockcounts.create", "inventorymovements.create", "locations.create"]);
  mocks.create.mockResolvedValue({ id: "cellar" }); mocks.update.mockResolvedValue({});
  mocks.outlet.mockResolvedValue({ id: "cellar", name: "Drinks cellar", inventoryRole: "central_storage", revision: 2 });
  mocks.approvers.mockResolvedValue([]);
  mocks.users.mockResolvedValue([]); mocks.setApprovers.mockResolvedValue({});
  mocks.pending.mockReturnValue(null); mocks.retry.mockResolvedValue({ resourceId: "cellar", revision: 3 });
});
afterEach(cleanup);
it("creates an entire-outlet stock point by default without requiring locations", async () => {
  render(<OutletCreatePage />);
  expect(screen.getByRole("radio", { name: /^Outlet/ })).toBeChecked();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Lobby bar" } });
  fireEvent.click(screen.getByRole("button", { name: "Save Outlet" }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledWith("hotel-a", { name: "Lobby bar", inventoryRole: "outlet", createdBy: "operator" }));
  expect(mocks.navigate).toHaveBeenCalledWith("/settings/outlets");
});
it("configures a central stock point for deliveries and requisitions", async () => {
  render(<OutletCreatePage />);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Drinks cellar" } });
  fireEvent.click(screen.getByRole("radio", { name: /^Central stock point/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save Outlet" }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledWith("hotel-a", expect.objectContaining({ inventoryRole: "central_storage" })));
});
it("loads and deliberately updates the outlet inventory role", async () => {
  render(<OutletEditPage />);
  expect(await screen.findByRole("radio", { name: /^Central stock point/ })).toBeChecked();
  fireEvent.click(screen.getByRole("radio", { name: /^Outlet/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save Outlet" }));
  await waitFor(() => expect(mocks.update).toHaveBeenCalledWith("hotel-a", "cellar", expect.objectContaining({ name: "Drinks cellar", inventoryRole: "outlet" })));
});
it("offers scoped count, requisition and optional location entry points", async () => {
  render(<OutletDetailPage />);
  await screen.findByText("Drinks cellar");
  fireEvent.click(screen.getByRole("button", { name: "Start stock count" }));
  expect(mocks.navigate).toHaveBeenCalledWith("/catalog/stock-counts/new?outletId=cellar");
  fireEvent.click(screen.getByRole("button", { name: "Record requisition" }));
  expect(mocks.navigate).toHaveBeenCalledWith("/catalog/inventory-movements?type=requisition&sourceOutletId=cellar");
  fireEvent.click(screen.getByRole("button", { name: "Add optional location" }));
  expect(mocks.navigate).toHaveBeenCalledWith("/settings/locations/new?outletId=cellar");
});
it("keeps archived stock points readable without starting new inventory workflows", async () => {
  mocks.outlet.mockResolvedValue({ id: "cellar", name: "Drinks cellar", inventoryRole: "central_storage", archived: true });
  render(<OutletDetailPage />); await screen.findByText("Drinks cellar");
  expect(screen.queryByRole("button", { name: "Record requisition" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Start stock count" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Add optional location" })).not.toBeInTheDocument();
});
it("ignores a creation response belonging to an earlier authenticated session", async () => {
  let resolve; mocks.create.mockReturnValue(new Promise((done) => { resolve = done; }));
  const view = render(<OutletCreatePage />);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Lobby bar" } });
  fireEvent.click(screen.getByRole("button", { name: "Save Outlet" }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
  mocks.auth.currentUser = { uid: "operator" }; view.rerender(<OutletCreatePage />);
  await act(async () => resolve({ id: "old-outlet" }));
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Name")).toHaveValue("");
});
it("recovers the original created stock point after remount without generating a replacement", async () => {
  mocks.pending.mockReturnValue({ action: "create", resourceId: "original-cellar", resource: { name: "Drinks cellar", inventoryRole: "central_storage" } });
  mocks.retry.mockResolvedValue({ resourceId: "original-cellar", revision: 1 });
  render(<OutletCreatePage />);
  expect(await screen.findByText("A saved outlet request needs confirmation")).toBeInTheDocument();
  expect(screen.getByLabelText("Name")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save Outlet" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Retry saved outlet request" }));
  await waitFor(() => expect(mocks.retry).toHaveBeenCalledWith("hotel-a", "outlets", "new"));
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.navigate).toHaveBeenCalledWith("/settings/outlets/original-cellar");
});
it("keeps the original pending update frozen even when the current outlet has a newer revision", async () => {
  mocks.pending.mockReturnValue({ action: "update", resourceId: "cellar", expectedRevision: 1, resource: { name: "Saved cellar", inventoryRole: "central_storage" } });
  render(<OutletEditPage />);
  await screen.findByRole("radio", { name: /^Central stock point/ });
  expect(screen.getByLabelText("Name")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Retry saved outlet request" }));
  await waitFor(() => expect(mocks.retry).toHaveBeenCalledWith("hotel-a", "outlets", "cellar"));
  expect(mocks.update).not.toHaveBeenCalled();
});
it("locks replacement settings when browser recovery storage cannot be read", async () => {
  mocks.pending.mockImplementation(() => { throw new Error("Saved resource request cannot be read."); });
  render(<OutletCreatePage />);
  expect(await screen.findByText("Saved resource request cannot be read.")).toBeInTheDocument();
  expect(screen.getByLabelText("Name")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save Outlet" })).toBeDisabled();
});
it("retries approvers after settings were saved without repeating a stale-revision metadata update", async () => {
  mocks.permissions.add("outlets.approvers");
  mocks.setApprovers.mockRejectedValueOnce(new Error("Approver request failed."));
  render(<OutletEditPage />);
  await screen.findByRole("radio", { name: /^Central stock point/ });
  fireEvent.click(screen.getByRole("button", { name: "Save Outlet" }));
  expect(await screen.findByText("Approver request failed.")).toBeInTheDocument();
  expect(screen.getByLabelText("Name")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save Outlet" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Save Outlet" }));
  await waitFor(() => expect(mocks.setApprovers).toHaveBeenCalledTimes(2));
  expect(mocks.update).toHaveBeenCalledTimes(1);
  expect(mocks.navigate).toHaveBeenCalledWith("/settings/outlets/cellar");
});
