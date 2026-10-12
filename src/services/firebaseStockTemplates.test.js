import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ call: vi.fn(), getDoc: vi.fn(), updateDoc: vi.fn(), setDoc: vi.fn() }));
vi.mock("../firebaseConfig", () => ({ auth: { currentUser: { uid: "person" } }, db: {}, functions: {}, collection: (_db, path) => ({ path }), doc: (_db, path, id) => ({ path: `${path}/${id}` }), getDoc: mocks.getDoc, getDocs: vi.fn(), updateDoc: mocks.updateDoc, setDoc: mocks.setDoc, deleteDoc: vi.fn(), writeBatch: vi.fn(), httpsCallable: (_functions, name) => async (input) => ({ data: await mocks.call(name, input) }) }));
vi.mock("firebase/firestore", () => ({ runTransaction: vi.fn() }));
import { addLocationStockTemplateItem, createLocationStockTemplate, getPendingStockTemplateCommand, retryPendingStockTemplateCommand, removeLocationStockTemplateItem, updateLocationStockTemplateItems } from "./firebaseSettings";
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear();
  mocks.call.mockImplementation(async (_name, input) => ({ hotelUid: input.hotelUid, locationId: input.locationId, templateId: input.templateId, revision: 7 }));
});
describe("protected stock template command adapter", () => {
  it("sends only identities to the server with loaded revision and actor-scoped retry", async () => {
    await addLocationStockTemplateItem("hotel", "store", "template", { catalogProductId: "milk", unitCost: 999 }, 6);
    expect(mocks.call).toHaveBeenCalledWith("mutateHotelStockTemplate", expect.objectContaining({ hotelUid: "hotel", locationId: "store", templateId: "template", action: "add-item", item: { catalogProductId: "milk" }, expectedRevision: 6, requestId: expect.any(String) }));
    expect(mocks.getDoc).not.toHaveBeenCalled(); expect(mocks.updateDoc).not.toHaveBeenCalled(); expect(mocks.setDoc).not.toHaveBeenCalled();
  });
  it("preserves legacy identities for removal/reorder without silently discarding invalid items", async () => {
    await updateLocationStockTemplateItems("hotel", "store", "template", [{ supplierProductId: "old", outletId: "bar" }, { catalogProductId: "milk" }], 6);
    expect(mocks.call.mock.calls[0][1].items).toEqual([{ supplierProductId: "old", outletId: "bar" }, { catalogProductId: "milk" }]);
    await removeLocationStockTemplateItem("hotel", "store", "template", { supplierProductId: "old", outletId: "bar" }, undefined, 7);
    expect(mocks.call.mock.calls[1][1].item).toEqual({ supplierProductId: "old", outletId: "bar" });
    await expect(updateLocationStockTemplateItems("hotel", "store", "template", [{ unknown: "bad" }], 7)).rejects.toThrow("not discarded");
    await expect(addLocationStockTemplateItem("hotel", "store", "template", { supplierProductId: "old", outletId: "bar" }, 7)).rejects.toThrow("catalog products");
  });
  it("retries exact creation after response loss and blocks changed requests", async () => {
    mocks.call.mockRejectedValueOnce(new Error("Connection lost"));
    await expect(createLocationStockTemplate("hotel", "store", "Weekly")).rejects.toThrow("Connection lost");
    await expect(createLocationStockTemplate("hotel", "store", "Different")).rejects.toThrow("awaiting confirmation");
    await createLocationStockTemplate("hotel", "store", "Weekly");
    expect(mocks.call.mock.calls[0][1]).toEqual(mocks.call.mock.calls[1][1]);
    expect(mocks.call.mock.calls[1][1]).toMatchObject({ action: "create", name: "Weekly", expectedRevision: 0 });
  });
  it("clears only a server-proven uncommitted domain failure and rejects wrong scope", async () => {
    mocks.call.mockRejectedValueOnce(Object.assign(new Error("Bad source"), { details: { stockTemplateRequestUncommitted: true } }));
    await expect(addLocationStockTemplateItem("hotel", "store", "template", { catalogProductId: "bad" }, 7)).rejects.toThrow("Bad source");
    await addLocationStockTemplateItem("hotel", "store", "template", { catalogProductId: "milk" }, 7);
    mocks.call.mockResolvedValueOnce({ hotelUid: "other", locationId: "store", templateId: "template", revision: 8 });
    await expect(addLocationStockTemplateItem("hotel", "store", "template", { catalogProductId: "flour" }, 7)).rejects.toThrow("scope");
    await expect(addLocationStockTemplateItem("hotel", "store", "template", { catalogProductId: "sugar" }, 7)).rejects.toThrow("awaiting confirmation");
  });
});

it("replays the saved removal after its result was lost without reconstructing current rows", async () => {
  mocks.call.mockRejectedValueOnce(new Error("Response lost after commit"));
  await expect(removeLocationStockTemplateItem("hotel", "store", "template", { catalogProductId: "milk" }, undefined, 6)).rejects.toThrow("Response lost");
  const pending = getPendingStockTemplateCommand("hotel", "store", "template");
  expect(pending).toMatchObject({ action: "remove-item", item: { catalogProductId: "milk" }, expectedRevision: 6 });
  await retryPendingStockTemplateCommand("hotel", "store", "template");
  expect(mocks.call.mock.calls[0][1]).toEqual(mocks.call.mock.calls[1][1]);
  expect(getPendingStockTemplateCommand("hotel", "store", "template")).toBeNull();
});
it("refuses to replace a corrupt saved template request", async () => {
  const key = "hotelsuite.stockTemplate:person:hotel:store:template";
  sessionStorage.setItem(key, "{broken");
  expect(() => getPendingStockTemplateCommand("hotel", "store", "template")).toThrow("outcome needs review");
  await expect(addLocationStockTemplateItem("hotel", "store", "template", { catalogProductId: "milk" }, 6)).rejects.toThrow("no replacement");
  expect(sessionStorage.getItem(key)).toBe("{broken"); expect(mocks.call).not.toHaveBeenCalled();
});
