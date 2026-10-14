import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ call: vi.fn(), getDocs: vi.fn(), getDoc: vi.fn(), auth: { currentUser: { uid: "hotel-admin" } } }));
vi.mock("../firebaseConfig", () => ({ auth: mocks.auth, functions: {}, db: {}, collection: (_db, path) => ({ path }),
  doc: (source, path, id) => ({ path: source?.path ? `${source.path}/generated-resource` : id ? `${path}/${id}` : path,
    id: source?.path ? "generated-resource" : id || path?.split("/").at(-1) }), getDocs: mocks.getDocs, getDoc: mocks.getDoc,
  httpsCallable: (_functions, endpoint) => async (input) => ({ data: await mocks.call(endpoint, input) }) }));
vi.mock("firebase/firestore", () => ({ runTransaction: vi.fn() }));
import { archiveLocation, archiveOutlet, createOutlet, updateOutlet, createLocation, updateLocation, getLocationOutletChoices, getLocations, getOutlets, getLocationById, getOutletById, getHotelStockTemplateDisplay,
  getPendingProcurementResourceCommand, retryPendingProcurementResourceCommand } from "./firebaseSettings";
import { invalidateProcurementReads } from "./procurementReadPool";

beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); invalidateProcurementReads(); mocks.auth.currentUser = { uid: "hotel-admin" };
  mocks.call.mockImplementation(async (_endpoint, input) => ({ hotelUid: input.hotelUid, collection: input.collection, resourceId: input.resourceId, revision: input.expectedRevision + 1, archived: true }));
  mocks.getDocs.mockResolvedValue({ docs: [] });
});

describe("protected outlet and location setup", () => {
  it("creates outlet and linked locations through protected commands and retains server revisions", async () => {
    mocks.call.mockImplementation(async (_endpoint, input) => ({ hotelUid: input.hotelUid, collection: input.collection,
      resourceId: input.resourceId, revision: input.expectedRevision + 1, archived: false }));
    const outlet = await createOutlet("hotel-a", { name: " Cellar ", inventoryRole: "central_storage", createdBy: "spoofed" });
    expect(outlet).toEqual({ id: "generated-resource", name: "Cellar", inventoryRole: "central_storage", revision: 1 });
    expect(mocks.call.mock.calls[0][1]).toMatchObject({ collection: "outlets", action: "create", resource: { name: "Cellar", inventoryRole: "central_storage" } });
    await createLocation("hotel-a", { name: "Rack", outletId: outlet.id });
    expect(mocks.call.mock.calls[1][1]).toMatchObject({ collection: "locations", resource: { name: "Rack", outletId: outlet.id } });
    await expect(createLocation("hotel-a", { name: "Unassigned" })).rejects.toThrow("Outlet ID");
  });
  it("keeps the originally loaded revision and allows exact update replay after uncertain outcomes", async () => {
    mocks.call.mockRejectedValueOnce(new Error("Response lost")).mockImplementation(async (_endpoint, input) => ({ hotelUid: input.hotelUid,
      collection: input.collection, resourceId: input.resourceId, archived: false, revision: input.expectedRevision + 1 }));
    await expect(updateOutlet("hotel-a", "bar", { name: "Bar", inventoryRole: "outlet", expectedRevision: 2 })).rejects.toThrow("Response lost");
    const original = mocks.call.mock.calls[0][1];
    await retryPendingProcurementResourceCommand("hotel-a", "outlets", "bar");
    expect(mocks.call.mock.calls[1][1]).toEqual(original);
    await updateLocation("hotel-a", "rack", { name: "New rack", expectedRevision: 4 });
    expect(mocks.call.mock.calls[2][1]).toMatchObject({ expectedRevision: 4, resource: { name: "New rack" } });
    expect(mocks.getDoc).not.toHaveBeenCalled();
  });
  it("recovers a creation using its generated identity rather than creating a duplicate after remount", async () => {
    mocks.call.mockRejectedValueOnce(new Error("Response lost")).mockImplementation(async (_endpoint, input) => ({ hotelUid: input.hotelUid,
      collection: input.collection, resourceId: input.resourceId, archived: false, revision: 1 }));
    await expect(createOutlet("hotel-a", { name: "Cellar" })).rejects.toThrow("Response lost");
    const original = mocks.call.mock.calls[0][1];
    expect(getPendingProcurementResourceCommand("hotel-a", "outlets", "new")).toMatchObject({ resourceId: "generated-resource", action: "create" });
    const result = await retryPendingProcurementResourceCommand("hotel-a", "outlets", "new");
    expect(result.resourceId).toBe("generated-resource"); expect(mocks.call.mock.calls[1][1]).toEqual(original);
    expect(getPendingProcurementResourceCommand("hotel-a", "outlets", "new")).toBeNull();
  });
  it("requests a narrow active outlet picker using the location action", async () => {
    const outlets = [{ id: "bar", name: "Bar", inventoryRole: "outlet" }];
    mocks.call.mockResolvedValue({ hotelUid: "hotel-a", outlets });
    expect(await getLocationOutletChoices("hotel-a", "update")).toEqual(outlets);
    expect(mocks.call).toHaveBeenCalledWith("getHotelLocationOutletChoices", { hotelUid: "hotel-a", action: "update" });
    expect(mocks.getDocs).not.toHaveBeenCalled();
  });
});

describe("protected procurement resource archival", () => {
  it.each([["locations", archiveLocation], ["outlets", archiveOutlet]])("archives %s through a scoped command rather than deleting browser documents", async (collection, archive) => {
    await archive("hotel-a", "resource", 7);
    expect(mocks.call).toHaveBeenCalledWith("mutateHotelProcurementResource", {
      hotelUid: "hotel-a", collection, resourceId: "resource", action: "archive", expectedRevision: 7, requestId: expect.any(String),
    });
    expect(getPendingProcurementResourceCommand("hotel-a", collection, "resource")).toBeNull();
    expect(mocks.getDocs).not.toHaveBeenCalled();
  });

  it("preserves and replays the exact request after an uncertain response", async () => {
    mocks.call.mockRejectedValueOnce(new Error("Response lost"));
    await expect(archiveLocation("hotel-a", "store", 2)).rejects.toThrow("Response lost");
    const original = mocks.call.mock.calls[0][1];
    expect(getPendingProcurementResourceCommand("hotel-a", "locations", "store")).toMatchObject({ expectedRevision: 2, resourceId: "store" });
    await expect(archiveLocation("hotel-a", "store", 3)).rejects.toThrow("uncertain");
    expect(mocks.call).toHaveBeenCalledTimes(1);
    await retryPendingProcurementResourceCommand("hotel-a", "locations", "store");
    expect(mocks.call.mock.calls[1][1]).toEqual(original);
  });

  it("separates pending operations by hotel and authenticated actor", async () => {
    mocks.call.mockRejectedValue(new Error("Offline"));
    await expect(archiveOutlet("hotel-a", "bar")).rejects.toThrow("Offline");
    await expect(archiveOutlet("hotel-b", "bar")).rejects.toThrow("Offline");
    mocks.auth.currentUser = { uid: "other-admin" };
    expect(getPendingProcurementResourceCommand("hotel-a", "outlets", "bar")).toBeNull();
    await expect(archiveOutlet("hotel-a", "bar")).rejects.toThrow("Offline");
    expect(new Set(mocks.call.mock.calls.map(([, input]) => input.requestId)).size).toBe(3);
  });

  it("allows a new revision only after current server proof of non-commit", async () => {
    mocks.call.mockRejectedValueOnce(Object.assign(new Error("Conflict"), { details: { resourceRequestUncommitted: true } }));
    await expect(archiveLocation("hotel-a", "store", 2)).rejects.toThrow("Conflict");
    await archiveLocation("hotel-a", "store", 3);
    expect(mocks.call.mock.calls[1][1].requestId).not.toBe(mocks.call.mock.calls[0][1].requestId);
    expect(mocks.call.mock.calls[1][1].expectedRevision).toBe(3);
  });

  it("retains pending evidence when a response has the wrong hotel", async () => {
    mocks.call.mockResolvedValue({ hotelUid: "hotel-b", collection: "locations", resourceId: "store", archived: true, revision: 1 });
    await expect(archiveLocation("hotel-a", "store")).rejects.toThrow("could not be validated");
    expect(getPendingProcurementResourceCommand("hotel-a", "locations", "store")).not.toBeNull();
  });

  it("fails malformed saved requests without replacing the uncertain operation", async () => {
    const key = "procurement-resource-command:hotel-admin:hotel-a:locations:store";
    sessionStorage.setItem(key, "broken");
    expect(() => getPendingProcurementResourceCommand("hotel-a", "locations", "store")).toThrow("no replacement");
    await expect(archiveLocation("hotel-a", "store")).rejects.toThrow("no replacement");
    expect(sessionStorage.getItem(key)).toBe("broken"); expect(mocks.call).not.toHaveBeenCalled();
  });

  it.each([["locations", getLocations], ["outlets", getOutlets]])("excludes archived %s from new selections and retains them for settings history", async (_collection, list) => {
    mocks.getDocs.mockResolvedValue({ docs: [
      { id: "open", data: () => ({ id: "stale-stored-id", name: "Open" }) },
      { id: "archived", data: () => ({ name: "Archived", active: false, archived: true }) },
      { id: "inactive", data: () => ({ name: "Inactive", active: false }) },
    ] });
    expect((await list("hotel-a")).map((resource) => resource.id)).toEqual(["open"]);
    expect((await list("hotel-a", { includeArchived: true })).map((resource) => resource.id)).toEqual(["archived", "inactive", "open"]);
  });

  it.each([["location", getLocationById], ["outlet", getOutletById]])("uses the canonical %s document ID and keeps archived detail history", async (_type, get) => {
    mocks.getDoc.mockResolvedValue({ exists: () => true, id: "canonical-id", data: () => ({ id: "stale-stored-id", name: "Archived", archived: true }) });
    expect(await get("hotel-a", "canonical-id")).toMatchObject({ id: "canonical-id", archived: true });
  });

  it("rejects stale SDK-cached setting options after offline access changes", async () => {
    mocks.getDocs.mockResolvedValue({ metadata: { fromCache: true }, docs: [] });
    await expect(getLocations("hotel-a")).rejects.toThrow("verified with the server");
    await expect(getOutlets("hotel-a")).rejects.toThrow("verified with the server");
  });
});

describe("stock template labels", () => {
  const bundled = () => ({ hotelUid: "hotel-a", locationId: "store", templateId: "weekly",
    location: { id: "store", name: "Cold room", archived: false },
    template: { id: "weekly", name: "Weekly", revision: 3, archived: false, items: [{ catalogProductId: "milk" }] },
    items: [{ catalogProductId: "milk", catalogProductName: "Milk", baseUnit: "l", available: true }] });
  it("requests only the selected hotel's template display projection", async () => {
    const data = { hotelUid: "hotel-a", locationId: "store", templateId: "weekly",
      location: { id: "store", name: "Cold room", archived: false },
      template: { id: "weekly", name: "Weekly", revision: 3, archived: false, items: [{ catalogProductId: "milk" }] },
      items: [{ catalogProductId: "milk", catalogProductName: "Milk", baseUnit: "l", available: true }] };
    mocks.call.mockResolvedValue(data);
    expect(await getHotelStockTemplateDisplay("hotel-a", "store", "weekly")).toEqual(data);
    expect(mocks.call).toHaveBeenCalledWith("getHotelStockTemplateDisplay", { hotelUid: "hotel-a", locationId: "store", templateId: "weekly" });
    expect(mocks.getDocs).not.toHaveBeenCalled();
  });

  it("rejects cross-hotel template display responses", async () => {
    mocks.call.mockResolvedValue({ hotelUid: "hotel-b", locationId: "store", templateId: "weekly", items: [] });
    await expect(getHotelStockTemplateDisplay("hotel-a", "store", "weekly")).rejects.toThrow("scope is invalid");
  });
  it.each([
    (data) => { data.template.revision = "3"; },
    (data) => { data.location.id = "other"; },
    (data) => { data.template.items = [{ catalogProductId: "other" }]; },
    (data) => { data.items[0].catalogProductName = { name: "Milk" }; },
    (data) => { data.items[0].baseUnit = "litres"; },
    (data) => { data.items[0].available = "true"; },
    (data) => { data.template.items.push(data.template.items[0]); data.items.push(data.items[0]); },
  ])("rejects incoherent revisions, duplicate/unaligned rows and malformed names or units", async (change) => {
    const data = bundled(); change(data); mocks.call.mockResolvedValue(data);
    await expect(getHotelStockTemplateDisplay("hotel-a", "store", "weekly")).rejects.toThrow();
  });
  it("shares only same-authority concurrent projections and has no settled template cache", async () => {
    mocks.call.mockResolvedValue(bundled());
    await Promise.all([
      getHotelStockTemplateDisplay("hotel-a", "store", "weekly", { scopeKey: "access-a" }),
      getHotelStockTemplateDisplay("hotel-a", "store", "weekly", { scopeKey: "access-a" }),
      getHotelStockTemplateDisplay("hotel-a", "store", "weekly", { scopeKey: "access-b" }),
    ]);
    expect(mocks.call).toHaveBeenCalledTimes(2);
    await getHotelStockTemplateDisplay("hotel-a", "store", "weekly", { scopeKey: "access-a" });
    expect(mocks.call).toHaveBeenCalledTimes(3);
  });
  it("rejects an old projection if Auth is replaced by a new object with the same UID", async () => {
    let resolve;
    mocks.call.mockReturnValue(new Promise((done) => { resolve = done; }));
    const pending = getHotelStockTemplateDisplay("hotel-a", "store", "weekly");
    await Promise.resolve();
    mocks.auth.currentUser = { uid: "hotel-admin" };
    resolve(bundled());
    await expect(pending).rejects.toThrow("access changed");
  });
});
