import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LocationStockTemplateDetailPage from "./LocationStockTemplateDetailPage";
import LocationSettingsPage from "./LocationSettingsPage";
import OutletDetailPage from "./OutletDetailPage";
import ProcurementResourceArchive from "./ProcurementResourceArchive";
import OutletCreatePage from "./OutletCreatePage";

const mocks = vi.hoisted(() => ({
  hotel: "hotel-a",
  permissions: new Set(),
  params: { locationId: "store", templateId: "weekly", outletId: "bar" },
  navigate: vi.fn(),
  locations: vi.fn(),
  location: vi.fn(),
  template: vi.fn(),
  display: vi.fn(),
  catalog: vi.fn(),
  add: vi.fn(),
  move: vi.fn(),
  remove: vi.fn(),
  outlet: vi.fn(),
  approvers: vi.fn(),
  archiveLocation: vi.fn(),
  archiveOutlet: vi.fn(),
  pending: vi.fn(),
  retry: vi.fn(),
  users: vi.fn(),
  createOutlet: vi.fn(),
  setApprovers: vi.fn(),
  actorUid: "actor",
  actors: new Map(),
  pendingTemplate: vi.fn(),
  retryTemplate: vi.fn(),
}));
vi.mock("react-router-dom", () => ({
  useNavigate: () => mocks.navigate,
  useParams: () => mocks.params,
  Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key) => key }),
}));
vi.mock("../../contexts/HotelContext", () => ({
  useHotelContext: () => ({ hotelUid: mocks.hotel }),
}));
vi.mock("../../hooks/usePermission", () => ({
  usePermission: (feature, action) =>
    mocks.permissions.has(`${feature}.${action}`),
}));
vi.mock("../../firebaseConfig", () => ({
  auth: { get currentUser() {
    if (!mocks.actors.has(mocks.actorUid)) mocks.actors.set(mocks.actorUid, { uid: mocks.actorUid });
    return mocks.actors.get(mocks.actorUid);
  } },
  signOut: vi.fn(),
}));
vi.mock("../layout/HeaderBar", () => ({ default: () => null }));
vi.mock("../../services/firebaseStockCounts", () => ({
  getPendingCountCreation: () => null,
  retryPendingCountCreation: vi.fn(),
}));
vi.mock("../../services/firebaseProducts", () => ({
  getCatalogProducts: mocks.catalog,
}));
vi.mock("../../services/firebaseOnboarding", () => ({
  listHotelUsers: mocks.users,
}));
vi.mock("../../services/firebaseSettings", () => ({
  getLocations: mocks.locations,
  getLocationById: mocks.location,
  getLocationStockTemplateById: mocks.template,
  getHotelStockTemplateDisplay: mocks.display,
  addLocationStockTemplateItem: mocks.add,
  updateLocationStockTemplateItems: mocks.move,
  removeLocationStockTemplateItem: mocks.remove,
  getOutletById: mocks.outlet,
  getOutletApprovers: mocks.approvers,
  archiveLocation: mocks.archiveLocation,
  archiveOutlet: mocks.archiveOutlet,
  getPendingProcurementResourceCommand: mocks.pending,
  retryPendingProcurementResourceCommand: mocks.retry,
  createOutlet: mocks.createOutlet,
  setOutletApprovers: mocks.setApprovers,
  getPendingStockTemplateCommand: mocks.pendingTemplate,
  retryPendingStockTemplateCommand: mocks.retryTemplate,
}));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const template = {
  id: "weekly",
  name: "Weekly count",
  revision: 3,
  items: [{ catalogProductId: "orange-id" }],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.hotel = "hotel-a";
  mocks.actorUid = "actor";
  mocks.permissions = new Set([
    "locations.read",
    "locations.update",
    "locations.delete",
    "outlets.read",
    "outlets.update",
    "outlets.delete",
    "outlets.create",
    "outlets.approvers",
  ]);
  mocks.location.mockResolvedValue({
    id: "store",
    name: "Cold room",
    revision: 2,
  });
  mocks.template.mockResolvedValue(template);
  mocks.display.mockResolvedValue({
    hotelUid: "hotel-a",
    locationId: "store",
    templateId: "weekly",
    items: [
      {
        catalogProductId: "orange-id",
        catalogProductName: "Orange juice",
        baseUnit: "l",
        available: true,
      },
    ],
  });
  mocks.catalog.mockResolvedValue({
    products: [],
    hasMore: false,
    cursor: null,
  });
  mocks.locations.mockResolvedValue([
    { id: "store", name: "Cold room" },
    { id: "old", name: "Old store", archived: true },
  ]);
  mocks.outlet.mockResolvedValue({ id: "bar", name: "Bar", revision: 4 });
  mocks.approvers.mockResolvedValue([]);
  mocks.pending.mockReturnValue(null);
  mocks.pendingTemplate.mockReset().mockReturnValue(null);
  mocks.retryTemplate.mockReset().mockResolvedValue({ revision: 4 });
  mocks.add.mockReset().mockResolvedValue({ revision: 4 });
  mocks.archiveLocation.mockResolvedValue({ archived: true });
  mocks.archiveOutlet.mockResolvedValue({ archived: true });
  mocks.users.mockResolvedValue([]);
  mocks.createOutlet.mockResolvedValue({ id: "new-outlet" });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("template article names and choices", () => {
  it("resolves names for a location reader without catalog or supplier read access", async () => {
    render(<LocationStockTemplateDetailPage />);
    expect(await screen.findByText("Orange juice")).toBeInTheDocument();
    expect(screen.queryByText("orange-id")).not.toBeInTheDocument();
    expect(mocks.catalog).not.toHaveBeenCalled();
    expect(mocks.display).toHaveBeenCalledWith("hotel-a", "store", "weekly");
    expect(
      screen.getByText(/Catalog read permission is required/),
    ).toBeInTheDocument();
  });
  it("keeps saved names visible when additional catalog choices fail", async () => {
    mocks.permissions.add("catalogproducts.read");
    mocks.catalog.mockRejectedValue(new Error("Choices offline"));
    render(<LocationStockTemplateDetailPage />);
    expect(await screen.findByText("Orange juice")).toBeInTheDocument();
    expect(await screen.findByText("Choices offline")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add product" })).toBeDisabled();
  });
  it("marks missing references explicitly, preserving rows rather than displaying an ID as a name", async () => {
    mocks.display.mockResolvedValue({
      items: [
        {
          catalogProductId: "orange-id",
          catalogProductName: null,
          baseUnit: null,
          available: false,
        },
      ],
    });
    render(<LocationStockTemplateDetailPage />);
    expect(
      await screen.findByText("Article name unavailable"),
    ).toBeInTheDocument();
    expect(screen.getByText("Reference: orange-id")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove", exact: true }),
    ).toBeInTheDocument();
    expect(screen.getByText(/not silently omitted/)).toBeInTheDocument();
  });
  it("requires an explicit combobox choice and adds only eligible articles with the current revision", async () => {
    mocks.permissions.add("catalogproducts.read");
    mocks.catalog.mockResolvedValue({
      products: [
        {
          id: "orange-id",
          name: "Orange juice",
          baseUnit: "l",
          inventoryTracked: true,
        },
        { id: "milk", name: "Milk", baseUnit: "l", inventoryTracked: true },
        {
          id: "untracked",
          name: "Untracked article",
          baseUnit: "each",
          inventoryTracked: false,
        },
        {
          id: "archived",
          name: "Archived article",
          baseUnit: "each",
          inventoryTracked: true,
          archived: true,
        },
      ],
      hasMore: false,
      cursor: null,
    });
    render(<LocationStockTemplateDetailPage />);
    await screen.findByText("Orange juice");
    const picker = screen.getByRole("combobox", { name: "Catalog product" });
    await waitFor(() => expect(picker).toBeEnabled());
    expect(screen.getByRole("button", { name: "Add product" })).toBeDisabled();
    fireEvent.focus(picker);
    expect(
      screen.queryByRole("option", { name: /Untracked article/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /Archived article/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /Orange juice/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "Milk (l (litres))" }));
    fireEvent.click(screen.getByRole("button", { name: "Add product" }));
    await waitFor(() =>
      expect(mocks.add).toHaveBeenCalledWith(
        "hotel-a",
        "store",
        "weekly",
        { catalogProductId: "milk" },
        3,
      ),
    );
  });
  it("leaves historical rows readable and disables editing for archived locations", async () => {
    mocks.location.mockResolvedValue({
      id: "store",
      name: "Cold room",
      archived: true,
    });
    render(<LocationStockTemplateDetailPage />);
    await screen.findByText("Orange juice");
    expect(
      screen.getByRole("button", { name: "Remove", exact: true }),
    ).toBeDisabled();
    expect(
      screen.getByText(/Historical rows remain visible/),
    ).toBeInTheDocument();
  });
  it("ignores the previous hotel's delayed name projection", async () => {
    const old = deferred();
    mocks.display.mockImplementation((hotel) =>
      hotel === "hotel-a"
        ? old.promise
        : Promise.resolve({
            items: [
              {
                catalogProductId: "orange-id",
                catalogProductName: "Hotel B juice",
                baseUnit: "l",
                available: true,
              },
            ],
          }),
    );
    const view = render(<LocationStockTemplateDetailPage />);
    mocks.hotel = "hotel-b";
    view.rerender(<LocationStockTemplateDetailPage />);
    await screen.findByText("Hotel B juice");
    await act(async () =>
      old.resolve({
        items: [
          {
            catalogProductId: "orange-id",
            catalogProductName: "Obsolete juice",
            available: true,
          },
        ],
      }),
    );
    expect(screen.queryByText("Obsolete juice")).not.toBeInTheDocument();
  });
});

describe("stock template command progress and reconciliation", () => {
  const savedIntent = () => ({
    hotelUid: "hotel-a",
    locationId: "store",
    templateId: "weekly",
    action: "add-item",
    item: { catalogProductId: "milk" },
    expectedRevision: 3,
    requestId: "9d2d757b-8908-4505-800f-5ef0e7a01234",
  });
  const allowMilkChoice = () => {
    mocks.permissions.add("catalogproducts.read");
    mocks.catalog.mockResolvedValue({
      products: [{ id: "milk", name: "Milk", baseUnit: "l", inventoryTracked: true }],
      hasMore: false,
      cursor: null,
    });
  };
  const chooseMilk = async () => {
    const picker = await screen.findByRole("combobox", { name: "Catalog product" });
    await waitFor(() => expect(picker).toBeEnabled());
    fireEvent.focus(picker);
    fireEvent.click(screen.getByRole("option", { name: "Milk (l (litres))" }));
    return picker;
  };

  it("shows accessible progress without a reconciliation warning for a normal in-flight add", async () => {
    allowMilkChoice();
    const flight = deferred();
    mocks.add.mockImplementation(() => {
      mocks.pendingTemplate.mockReturnValue(savedIntent());
      window.dispatchEvent(new Event("stock-template-command-changed"));
      return flight.promise;
    });
    render(<LocationStockTemplateDetailPage />);
    await chooseMilk();
    fireEvent.click(screen.getByRole("button", { name: "Add product" }));
    expect(screen.getByRole("status")).toHaveTextContent("Adding article…");
    expect(screen.queryByText(/needs reconciliation/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry saved request" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add product" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Add product" }));
    expect(mocks.add).toHaveBeenCalledTimes(1);
    await act(async () => {
      mocks.pendingTemplate.mockReturnValue(null);
      window.dispatchEvent(new Event("stock-template-command-changed"));
      flight.resolve({ revision: 4 });
    });
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(screen.queryByText(/needs reconciliation/)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(mocks.add).toHaveBeenCalledWith("hotel-a", "store", "weekly", { catalogProductId: "milk" }, 3);
  });

  it("preserves an uncertain rejected request and requires replay of its original intent", async () => {
    allowMilkChoice();
    const flight = deferred(), original = savedIntent();
    mocks.add.mockImplementation(() => {
      mocks.pendingTemplate.mockReturnValue(original);
      window.dispatchEvent(new Event("stock-template-command-changed"));
      return flight.promise;
    });
    render(<LocationStockTemplateDetailPage />);
    await chooseMilk();
    fireEvent.click(screen.getByRole("button", { name: "Add product" }));
    await act(async () => flight.reject(new Error("The response was lost.")));
    expect(await screen.findByText(/A saved template command needs reconciliation/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("The response was lost.");
    expect(screen.getByRole("button", { name: "Add product" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove", exact: true })).toBeDisabled();
    expect(mocks.pendingTemplate()).toEqual(original);
    mocks.retryTemplate.mockImplementation(async () => {
      expect(mocks.pendingTemplate()).toEqual(original);
      mocks.pendingTemplate.mockReturnValue(null);
      window.dispatchEvent(new Event("stock-template-command-changed"));
      return { revision: 4 };
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry saved request" }));
    await waitFor(() => expect(mocks.retryTemplate).toHaveBeenCalledWith("hotel-a", "store", "weekly"));
    await waitFor(() => expect(screen.queryByText(/needs reconciliation/)).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText("The response was lost.")).not.toBeInTheDocument());
    expect(mocks.add).toHaveBeenCalledTimes(1);
  });

  it("warns for a recovered intent after remount and blocks replacement edits", async () => {
    allowMilkChoice();
    const original = savedIntent();
    mocks.pendingTemplate.mockReturnValue(original);
    const first = render(<LocationStockTemplateDetailPage />);
    await screen.findByText(/needs reconciliation/);
    first.unmount();
    render(<LocationStockTemplateDetailPage />);
    expect(await screen.findByText(/needs reconciliation/)).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await screen.findByText("Orange juice");
    expect(screen.getByRole("button", { name: "Add product" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Retry saved request" })).toBeEnabled();
    expect(mocks.pendingTemplate()).toEqual(original);
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("keeps unreadable recovery storage explicit and blocks replacement edits", async () => {
    allowMilkChoice();
    mocks.pendingTemplate.mockImplementation(() => {
      throw new Error("The saved command cannot be read; its outcome needs review.");
    });
    render(<LocationStockTemplateDetailPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The saved command cannot be read");
    await screen.findByText("Orange juice");
    expect(screen.getByRole("button", { name: "Add product" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Retry saved request" })).not.toBeInTheDocument();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("does not hide a rejected error when the server proved the request uncommitted", async () => {
    allowMilkChoice();
    mocks.add.mockRejectedValue(new Error("This product is no longer available."));
    render(<LocationStockTemplateDetailPage />);
    await chooseMilk();
    fireEvent.click(screen.getByRole("button", { name: "Add product" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This product is no longer available.");
    expect(screen.queryByText(/needs reconciliation/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add product" })).toBeEnabled();
  });

  it("ignores the old actor's rejected response after switching authenticated users", async () => {
    allowMilkChoice();
    const flight = deferred(), original = savedIntent();
    mocks.add.mockImplementation(() => {
      mocks.pendingTemplate.mockImplementation(() => mocks.actorUid === "actor" ? original : null);
      window.dispatchEvent(new Event("stock-template-command-changed"));
      return flight.promise;
    });
    const view = render(<LocationStockTemplateDetailPage />);
    await chooseMilk();
    fireEvent.click(screen.getByRole("button", { name: "Add product" }));
    mocks.actorUid = "other-actor";
    view.rerender(<LocationStockTemplateDetailPage />);
    const picker = await chooseMilk();
    await act(async () => flight.reject(new Error("Obsolete actor response.")));
    expect(screen.queryByText("Obsolete actor response.")).not.toBeInTheDocument();
    expect(screen.queryByText(/needs reconciliation/)).not.toBeInTheDocument();
    expect(picker).toHaveValue("Milk (l (litres))");
    expect(screen.getByRole("button", { name: "Add product" })).toBeEnabled();
    mocks.actorUid = "actor";
    expect(mocks.pendingTemplate()).toEqual(original);
  });
});

describe("archival and scope-safe configuration", () => {
  it("keeps archived locations out of normal settings rows until explicitly requested", async () => {
    render(<LocationSettingsPage />);
    await screen.findByText("Cold room");
    expect(screen.queryByText("Old store")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show archived" }));
    expect(screen.getByText("Old store")).toBeInTheDocument();
    expect(mocks.locations).toHaveBeenCalledWith("hotel-a", {
      includeArchived: true,
    });
  });
  it.each([
    ["locations", "Archive location", "archiveLocation"],
    ["outlets", "Archive outlet", "archiveOutlet"],
  ])(
    "archives %s only after explaining reference preservation",
    async (collection, label, method) => {
      const completed = vi.fn();
      render(
        <ProcurementResourceArchive
          hotelUid="hotel-a"
          collection={collection}
          resource={{ id: "resource", name: "Example", revision: 7 }}
          onArchived={completed}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() =>
        expect(mocks[method]).toHaveBeenCalledWith("hotel-a", "resource", 7),
      );
      expect(window.confirm).toHaveBeenCalledWith(
        expect.stringContaining("historical references are preserved"),
      );
      expect(completed).toHaveBeenCalledTimes(1);
    },
  );
  it("does not archive after the preservation confirmation is canceled", () => {
    window.confirm.mockReturnValue(false);
    render(
      <ProcurementResourceArchive
        hotelUid="hotel-a"
        collection="locations"
        resource={{ id: "store", name: "Store" }}
        onArchived={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Archive location" }));
    expect(mocks.archiveLocation).not.toHaveBeenCalled();
  });
  it("blocks replacement archive requests when saved recovery data cannot be read", async () => {
    mocks.pending.mockImplementation(() => {
      throw new Error("Saved archive request needs review.");
    });
    render(
      <ProcurementResourceArchive
        hotelUid="hotel-a"
        collection="locations"
        resource={{ id: "store", name: "Store" }}
        onArchived={vi.fn()}
      />,
    );
    expect(
      await screen.findByText("Saved archive request needs review."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Archive location" }),
    ).toBeDisabled();
    expect(mocks.archiveLocation).not.toHaveBeenCalled();
  });
  it("can resolve an original uncertain command after the record already appears archived", async () => {
    mocks.pending.mockReturnValue({ requestId: "original" });
    render(
      <ProcurementResourceArchive
        hotelUid="hotel-a"
        collection="locations"
        resource={{ id: "store", name: "Store", archived: true }}
        onArchived={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Retry original archive request" }),
    );
    await waitFor(() =>
      expect(mocks.retry).toHaveBeenCalledWith("hotel-a", "locations", "store"),
    );
    expect(mocks.archiveLocation).not.toHaveBeenCalled();
  });
  it("does not expose archival to an update-only user", () => {
    mocks.permissions.delete("locations.delete");
    render(
      <ProcurementResourceArchive
        hotelUid="hotel-a"
        collection="locations"
        resource={{ id: "store", name: "Store" }}
        onArchived={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Archive location" }),
    ).not.toBeInTheDocument();
  });
  it("replays an unconfirmed original archive rather than generating a new command", async () => {
    mocks.pending.mockReturnValue({ requestId: "original" });
    render(
      <ProcurementResourceArchive
        hotelUid="hotel-a"
        collection="locations"
        resource={{ id: "store", name: "Store" }}
        onArchived={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Retry original archive request" }),
    );
    await waitFor(() =>
      expect(mocks.retry).toHaveBeenCalledWith("hotel-a", "locations", "store"),
    );
    expect(mocks.archiveLocation).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
  });
  it("does not navigate the newly selected hotel after an old archive response", async () => {
    const old = deferred(),
      completed = vi.fn();
    mocks.archiveOutlet.mockReturnValue(old.promise);
    const view = render(
      <ProcurementResourceArchive
        hotelUid="hotel-a"
        collection="outlets"
        resource={{ id: "bar", name: "Bar" }}
        onArchived={completed}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Archive outlet" }));
    view.rerender(
      <ProcurementResourceArchive
        hotelUid="hotel-b"
        collection="outlets"
        resource={{ id: "bar", name: "Other bar" }}
        onArchived={completed}
      />,
    );
    await act(async () => old.resolve({ archived: true }));
    expect(completed).not.toHaveBeenCalled();
  });
  it("renders archived outlet history without edit or archive actions", async () => {
    mocks.outlet.mockResolvedValue({
      id: "bar",
      name: "Old bar",
      archived: true,
    });
    render(<OutletDetailPage />);
    await screen.findByText("Old bar");
    expect(screen.getByRole("button", { name: "Edit outlet" })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Archive outlet" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Historical records remain available/),
    ).toBeInTheDocument();
  });
  it("does not assign approvers or navigate after outlet creation finishes for a former hotel", async () => {
    const old = deferred();
    mocks.createOutlet.mockReturnValue(old.promise);
    const view = render(<OutletCreatePage />);
    const name = screen.getByLabelText("Name");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save Outlet" }),
      ).toBeDisabled(),
    );
    fireEvent.change(name, { target: { value: "Test bar" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save Outlet" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save Outlet" }));
    await waitFor(() => expect(mocks.createOutlet).toHaveBeenCalled());
    mocks.hotel = "hotel-b";
    view.rerender(<OutletCreatePage />);
    await act(async () => old.resolve({ id: "old-created-outlet" }));
    expect(mocks.setApprovers).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(within(view.container).getByLabelText("Name")).toHaveValue("");
  });
});
