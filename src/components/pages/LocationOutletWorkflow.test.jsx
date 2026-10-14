import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LocationCreatePage from "./LocationCreatePage";
import LocationEditPage from "./LocationEditPage";
import LocationDetailPage from "./LocationDetailPage";
import LocationSettingsPage from "./LocationSettingsPage";

const mocks = vi.hoisted(() => ({
  hotelUid: "hotel-a", actor: { uid: "actor-a" }, permissions: new Set(),
  navigate: vi.fn(), location: vi.fn(), locations: vi.fn(), choices: vi.fn(), outlets: vi.fn(), outlet: vi.fn(),
  create: vi.fn(), update: vi.fn(), templates: vi.fn(),
  pending: vi.fn(), retry: vi.fn(),
}));
vi.mock("react-router-dom", () => ({
  useNavigate: () => mocks.navigate,
  useParams: () => ({ locationId: "fridge" }),
  Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("../../firebaseConfig", () => ({ auth: { get currentUser() { return mocks.actor; } }, signOut: vi.fn() }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotelUid, permissions: [...mocks.permissions] }) }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: (feature, action) => mocks.permissions.has(`${feature}.${action}`) }));
vi.mock("../../services/firebaseSettings", () => ({
  getLocationById: mocks.location, getLocations: mocks.locations, getLocationOutletChoices: mocks.choices,
  getOutlets: mocks.outlets, getOutletById: mocks.outlet, createLocation: mocks.create, updateLocation: mocks.update,
  getLocationStockTemplates: mocks.templates, createLocationStockTemplate: vi.fn(),
  getPendingProcurementResourceCommand: mocks.pending, retryPendingProcurementResourceCommand: mocks.retry,
}));
vi.mock("../layout/HeaderBar", () => ({ default: () => null }));
vi.mock("../inventory/PendingStockCommand", () => ({ default: () => null }));
vi.mock("./ProcurementResourceArchive", () => ({ default: () => <div data-testid="location-archive-control" /> }));

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { resolve, promise };
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.hotelUid = "hotel-a";
  mocks.actor = { uid: "actor-a" };
  mocks.permissions = new Set(["locations.create", "locations.read", "locations.update"]);
  mocks.choices.mockResolvedValue([{ id: "bar", name: "Lobby bar", inventoryRole: "outlet" },
    { id: "store", name: "Beverage store", inventoryRole: "central_storage" },
    { id: "closed", name: "Closed outlet", archived: true }]);
  mocks.location.mockResolvedValue({ id: "fridge", name: "Bar fridge", outletId: "bar", revision: 2 });
  mocks.locations.mockResolvedValue([{ id: "fridge", name: "Bar fridge", outletId: "bar" }]);
  mocks.outlets.mockResolvedValue([{ id: "bar", name: "Lobby bar" }]);
  mocks.outlet.mockResolvedValue({ id: "bar", name: "Lobby bar" });
  mocks.templates.mockResolvedValue([]);
  mocks.create.mockResolvedValue({ id: "fridge" });
  mocks.update.mockResolvedValue({ id: "fridge" });
  mocks.pending.mockReturnValue(null);
  mocks.retry.mockResolvedValue({ resourceId: "original-location" });
});
afterEach(cleanup);

describe("optional locations inside outlets", () => {
  it("lets a location-only administrator choose a parent without broad outlet read access", async () => {
    render(<LocationCreatePage />);
    await screen.findByRole("option", { name: "Beverage store · Central stock point" });
    expect(mocks.choices).toHaveBeenCalledWith("hotel-a", "create");
    expect(mocks.outlets).not.toHaveBeenCalled();
    expect(screen.queryByRole("option", { name: "Closed outlet" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: " Cellar " } });
    expect(screen.getByRole("button", { name: "Save Location" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Outlet"), { target: { value: "store" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Location" }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith("hotel-a", { name: "Cellar", outletId: "store", createdBy: "actor-a" }));
  });

  it("reassigns a location explicitly while preserving an unchanged parent during name edits", async () => {
    const view = render(<LocationEditPage />);
    await screen.findByRole("option", { name: "Lobby bar" });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Back bar fridge" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Location" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith("hotel-a", "fridge", { name: "Back bar fridge", expectedRevision: 2, updatedBy: "actor-a" }));
    view.unmount();
    render(<LocationEditPage />);
    await screen.findByRole("option", { name: "Beverage store · Central stock point" });
    fireEvent.change(screen.getByLabelText("Outlet"), { target: { value: "store" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Location" }));
    await waitFor(() => expect(mocks.update).toHaveBeenLastCalledWith("hotel-a", "fridge", { name: "Bar fridge", expectedRevision: 2, outletId: "store", updatedBy: "actor-a" }));
  });

  it("keeps legacy unassigned locations editable without forcing new outlet setup", async () => {
    mocks.location.mockResolvedValue({ id: "fridge", name: "Old store" });
    mocks.choices.mockResolvedValue([]);
    render(<LocationEditPage />);
    await screen.findByDisplayValue("Old store");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed store" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Location" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith("hotel-a", "fridge", { name: "Renamed store", expectedRevision: 0, updatedBy: "actor-a" }));
  });

  it("records an explicit unlink while retaining the frozen resource revision", async () => {
    render(<LocationEditPage />);
    await screen.findByRole("option", { name: "Lobby bar" });
    fireEvent.change(screen.getByLabelText("Outlet"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Location" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith("hotel-a", "fridge", { name: "Bar fridge", expectedRevision: 2, outletId: null, updatedBy: "actor-a" }));
  });

  it("keeps a name edit available when only the optional outlet lookup fails", async () => {
    mocks.choices.mockRejectedValue(new Error("Outlet lookup unavailable"));
    render(<LocationEditPage />);
    await screen.findByText("Outlet lookup unavailable");
    expect(screen.getByLabelText("Outlet")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Updated fridge" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Location" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith("hotel-a", "fridge", { name: "Updated fridge", expectedRevision: 2, updatedBy: "actor-a" }));
  });

  it("blocks archived location editing without loading new outlet choices", async () => {
    mocks.location.mockResolvedValue({ id: "fridge", name: "Old fridge", archived: true });
    render(<LocationEditPage />);
    await screen.findByDisplayValue("Old fridge");
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save Location" })).toBeDisabled();
    expect(mocks.choices).not.toHaveBeenCalled();
  });

  it("resets parent selections for a new hotel and ignores an old save response", async () => {
    const save = deferred();
    mocks.create.mockReturnValue(save.promise);
    const view = render(<LocationCreatePage />);
    await screen.findByRole("option", { name: "Lobby bar" });
    fireEvent.change(screen.getByLabelText("Outlet"), { target: { value: "bar" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Old hotel fridge" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Location" }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    mocks.hotelUid = "hotel-b";
    view.rerender(<LocationCreatePage />);
    await screen.findByRole("option", { name: "Lobby bar" });
    await act(async () => save.resolve({ id: "old" }));
    expect(screen.getByLabelText("Name")).toHaveValue("");
    expect(screen.getByLabelText("Outlet")).toHaveValue("");
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("clears old actor choices immediately even when the replacement has the same UID", async () => {
    const next = deferred();
    const view = render(<LocationCreatePage />);
    await screen.findByRole("option", { name: "Lobby bar" });
    fireEvent.change(screen.getByLabelText("Outlet"), { target: { value: "bar" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Former draft" } });
    mocks.actor = { uid: "actor-a" };
    mocks.choices.mockReturnValue(next.promise);
    view.rerender(<LocationCreatePage />);
    expect(screen.queryByRole("option", { name: "Lobby bar" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("");
    expect(screen.getByLabelText("Outlet")).toHaveValue("");
    await act(async () => next.resolve([{ id: "restaurant", name: "Restaurant" }]));
    expect(await screen.findByRole("option", { name: "Restaurant" })).toBeInTheDocument();
  });

  it("recovers the original creation after remount before allowing another location", async () => {
    mocks.pending.mockReturnValue({ action: "create", resourceId: "original-location", resource: { name: "Cellar", outletId: "store" }, expectedRevision: 0 });
    render(<LocationCreatePage />);
    expect(await screen.findByRole("button", { name: "Retry saved location request" })).toBeEnabled();
    expect(mocks.pending).toHaveBeenCalledWith("hotel-a", "locations", "new");
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByLabelText("Outlet")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save Location" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry saved location request" }));
    await waitFor(() => expect(mocks.retry).toHaveBeenCalledWith("hotel-a", "locations", "new"));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/settings/locations/original-location"));
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("recovers an uncertain update without replacing its saved revision with a freshly loaded one", async () => {
    mocks.location.mockResolvedValue({ id: "fridge", name: "Changed by another operator", outletId: "bar", revision: 3 });
    mocks.pending.mockReturnValue({ action: "update", resourceId: "fridge", resource: { name: "Original edit", outletId: "store" }, expectedRevision: 2 });
    render(<LocationEditPage />);
    await screen.findByDisplayValue("Changed by another operator");
    expect(screen.getByLabelText("Name")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry saved location request" }));
    await waitFor(() => expect(mocks.retry).toHaveBeenCalledWith("hotel-a", "locations", "fridge"));
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("blocks new writes when saved location recovery data cannot be read", async () => {
    mocks.pending.mockImplementation(() => { throw new Error("Saved location request needs review."); });
    render(<LocationCreatePage />);
    await screen.findByText("Saved location request needs review.");
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save Location" })).toBeDisabled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("reads the parent outlet only when authorized and explains template-free counts", async () => {
    const view = render(<LocationDetailPage />);
    await screen.findByText("Bar fridge");
    expect(screen.getByText("Linked outlet")).toBeInTheDocument();
    expect(mocks.outlet).not.toHaveBeenCalled();
    expect(screen.getByText("No templates yet. You can count without a template.")).toBeInTheDocument();
    mocks.permissions.add("outlets.read");
    view.rerender(<LocationDetailPage />);
    expect(await screen.findByRole("link", { name: "Lobby bar" })).toHaveAttribute("href", "/settings/outlets/bar");
    expect(mocks.outlet).toHaveBeenCalledWith("hotel-a", "bar");
  });

  it("shows optional parent names in settings without making outlet lookup a list prerequisite", async () => {
    mocks.permissions.add("outlets.read");
    mocks.outlets.mockRejectedValue(new Error("Outlets unavailable"));
    render(<LocationSettingsPage />);
    await screen.findByRole("link", { name: "Bar fridge" });
    expect(screen.getByText("Outlet unavailable")).toBeInTheDocument();
    expect(mocks.locations).toHaveBeenCalledWith("hotel-a", { includeArchived: true });
  });

  it("lists physical detail locations separately from the outlet's canonical stock point", async () => {
    mocks.locations.mockResolvedValue([
      { id: "fridge", name: "Bar fridge", outletId: "bar" },
      { id: "outlet:bar", name: "Whole Lobby bar", outletId: "bar", stockPointType: "outlet" },
      { id: "outlet:store", name: "Reserved whole store", outletId: "store" },
      { id: "default-point", name: "Whole Restaurant", outletId: "restaurant", stockPointType: "outlet" },
    ]);
    render(<LocationSettingsPage />);
    expect(await screen.findByRole("link", { name: "Bar fridge" })).toBeInTheDocument();
    expect(screen.queryByText("Whole Lobby bar")).not.toBeInTheDocument();
    expect(screen.queryByText("Reserved whole store")).not.toBeInTheDocument();
    expect(screen.queryByText("Whole Restaurant")).not.toBeInTheDocument();
  });

  it("keeps a whole-outlet stock point read-only through Location detail and edit links", async () => {
    mocks.location.mockResolvedValue({ id: "fridge", name: "Whole Lobby bar", outletId: "bar", stockPointType: "outlet", revision: 2 });
    const view = render(<LocationDetailPage />);
    await screen.findByText("Whole Lobby bar");
    expect(screen.getByRole("button", { name: "Edit location" })).toBeDisabled();
    expect(screen.queryByTestId("location-archive-control")).not.toBeInTheDocument();
    expect(screen.getByText(/Manage its name and status in Outlet settings/)).toBeInTheDocument();
    view.unmount();
    render(<LocationEditPage />);
    await screen.findByDisplayValue("Whole Lobby bar");
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByLabelText("Outlet")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save Location" })).toBeDisabled();
    expect(mocks.choices).not.toHaveBeenCalled();
  });

  it("does not load parent names for a location-only reader", async () => {
    render(<LocationSettingsPage />);
    await screen.findByRole("link", { name: "Bar fridge" });
    expect(mocks.outlets).not.toHaveBeenCalled();
  });
});
