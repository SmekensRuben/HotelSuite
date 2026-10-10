import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const records = new Map();
  let sequence = 0;
  const snapshot = (reference) => ({
    ref: reference,
    id: reference.path.split("/").at(-1),
    exists: () => records.has(reference.path),
    data: () => structuredClone(records.get(reference.path)),
  });
  const getDoc = vi.fn(async (reference) => snapshot(reference));
  const getDocs = vi.fn(async (reference) => ({
    docs: [...records.keys()].filter((path) => path.startsWith(`${reference.path}/`) && !path.slice(reference.path.length + 1).includes("/"))
      .map((path) => snapshot({ path })),
  }));
  const setDoc = vi.fn(async (reference, data) => records.set(reference.path, structuredClone(data)));
  const updateDoc = vi.fn(async (reference, data) => {
    if (!records.has(reference.path)) throw new Error("Document does not exist.");
    records.set(reference.path, { ...records.get(reference.path), ...structuredClone(data) });
  });
  const deleteDoc = vi.fn(async (reference) => records.delete(reference.path));
  const writeBatch = vi.fn(() => {
    const deletions = [];
    return { delete: (reference) => deletions.push(reference), commit: async () => deletions.forEach((reference) => records.delete(reference.path)) };
  });
  const runTransaction = vi.fn(async (_db, handler) => {
    const writes = [];
    const result = await handler({ get: getDoc, set: (reference, data) => writes.push([reference, data]), delete: (reference) => writes.push([reference, undefined]) });
    writes.forEach(([reference, data]) => data === undefined ? records.delete(reference.path) : records.set(reference.path, structuredClone(data)));
    return result;
  });
  return {
    records, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch, runTransaction,
    doc: vi.fn((databaseOrCollection, path, id) => {
      const documentPath = databaseOrCollection.path ? `${databaseOrCollection.path}/generated-${++sequence}` : id ? `${path}/${id}` : path;
      return { path: documentPath, id: documentPath.split("/").at(-1) };
    }),
    collection: vi.fn((_db, path) => ({ path })),
    functions: {}, httpsCallable: vi.fn(),
  };
});

vi.mock("../firebaseConfig", () => ({ db: {}, ...mocks }));
vi.mock("firebase/firestore", () => ({ runTransaction: mocks.runTransaction }));

import {
  createCatalogCategory, createCatalogSubcategory, createOperaUserMapping,
  deleteCatalogCategory, deleteCatalogSubcategory, deleteOperaUserMapping,
  getCatalogTaxonomy, getContractTaxonomy, getHotelBootstrap, getOperaSettings, getPropertySettings,
  updateCatalogCategory, updateOperaUserMapping,
} from "./firebaseSettings";

beforeEach(() => {
  mocks.records.clear();
  vi.clearAllMocks();
});

describe("domain-specific settings access", () => {
  it("loads bootstrap independently and never falls back to the retired shared configuration", async () => {
    mocks.records.set("hotels/hotel/settings/hotel", { hotelName: "Legacy", operaUserMappings: { SECRET: "Private employee" }, hotelRooms: 100 });
    mocks.records.set("hotels/hotel/settings/bootstrap", { hotelName: "Identity" });
    expect(await getHotelBootstrap("hotel")).toEqual({ hotelName: "Identity" });
    expect(await getPropertySettings("hotel")).toEqual({});
    expect(await getOperaSettings("hotel")).toEqual({ operaUserMappings: {} });
    expect(await getContractTaxonomy("hotel")).toEqual({ categories: [], subcategories: [] });
    expect(mocks.getDoc.mock.calls.map(([reference]) => reference.path)).toEqual([
      "hotels/hotel/settings/bootstrap", "hotels/hotel/settings/propertySettings",
    ]);
  });

  it("creates and updates only the affected record, preserving concurrently added taxonomy", async () => {
    const category = await createCatalogCategory("hotel", { name: " Food ", unrelated: "discarded" });
    mocks.records.set("hotels/hotel/settings/catalog/categories/concurrent", { name: "Other operator" });
    await updateCatalogCategory("hotel", category.id, { name: "Food and drink" });
    const subcategory = await createCatalogSubcategory("hotel", { name: "Breakfast", categoryId: category.id });
    await deleteCatalogSubcategory("hotel", subcategory.id);
    expect(await getCatalogTaxonomy("hotel")).toEqual({
      categories: [{ name: "Food and drink", id: category.id }, { name: "Other operator", id: "concurrent" }],
      subcategories: [],
    });
    expect(mocks.setDoc).toHaveBeenCalledWith(expect.objectContaining({ path: expect.stringContaining("/settings/catalog/categories/") }), { name: "Food" });
    expect(mocks.updateDoc).toHaveBeenCalledWith(expect.objectContaining({ path: expect.stringContaining(category.id) }), { name: "Food and drink" });
  });

  it("cascades only current linked subcategories and keeps unrelated records after a fresh read", async () => {
    mocks.records.set("hotels/hotel/settings/catalog/categories/removed", { name: "Removed" });
    mocks.records.set("hotels/hotel/settings/catalog/categories/kept", { name: "Kept" });
    mocks.records.set("hotels/hotel/settings/catalog/subcategories/new-linked", { name: "Added since the page loaded", categoryId: "removed" });
    mocks.records.set("hotels/hotel/settings/catalog/subcategories/kept-sub", { name: "Kept child", categoryId: "kept" });
    await deleteCatalogCategory("hotel", "removed");
    expect(await getCatalogTaxonomy("hotel")).toEqual({ categories: [{ id: "kept", name: "Kept" }], subcategories: [{ id: "kept-sub", name: "Kept child", categoryId: "kept" }] });
  });

  it("fails an oversized category deletion before starting a batch", async () => {
    for (let index = 0; index < 400; index += 1) mocks.records.set(`hotels/hotel/settings/catalog/subcategories/${index}`, { name: "Child", categoryId: "category" });
    await expect(deleteCatalogCategory("hotel", "category")).rejects.toThrow("too many subcategories");
    expect(mocks.writeBatch).not.toHaveBeenCalled();
    expect(mocks.runTransaction).not.toHaveBeenCalled();
    expect(mocks.records.size).toBe(400);
  });

  it("keeps a subcategory moved to another category between enumeration and transaction", async () => {
    const childPath = "hotels/hotel/settings/catalog/subcategories/moved";
    mocks.records.set("hotels/hotel/settings/catalog/categories/removed", { name: "Removed" });
    mocks.records.set("hotels/hotel/settings/catalog/categories/kept", { name: "Kept" });
    mocks.records.set(childPath, { name: "Moved child", categoryId: "removed" });
    const original = mocks.runTransaction.getMockImplementation();
    mocks.runTransaction.mockImplementationOnce(async (...arguments_) => {
      mocks.records.set(childPath, { name: "Moved child", categoryId: "kept" });
      return original(...arguments_);
    });
    await deleteCatalogCategory("hotel", "removed");
    expect(mocks.records.get(childPath)).toEqual({ name: "Moved child", categoryId: "kept" });
  });

  it("removes an Opera key permanently while preserving another operator's changes", async () => {
    await createOperaUserMapping("hotel", { operaUser: "OP.1", employeeName: "First" });
    await createOperaUserMapping("hotel", { operaUser: "OP2", employeeName: "Second" });
    await updateOperaUserMapping("hotel", "OP2", "Updated by another operator");
    await deleteOperaUserMapping("hotel", "OP.1");
    expect(mocks.deleteDoc).toHaveBeenCalledWith(expect.objectContaining({ path: "hotels/hotel/settings/opera/userMappings/OP.1" }));
    expect(await getOperaSettings("hotel")).toEqual({ operaUserMappings: { OP2: "Updated by another operator" } });
  });

  it("rejects duplicate Opera creates and absent updates instead of silently upserting", async () => {
    await createOperaUserMapping("hotel", { operaUser: "OP1", employeeName: "Original" });
    await expect(createOperaUserMapping("hotel", { operaUser: "OP1", employeeName: "Replacement" })).rejects.toThrow("already has a mapping");
    await expect(updateOperaUserMapping("hotel", "missing", "Employee")).rejects.toThrow("does not exist");
    expect(await getOperaSettings("hotel")).toEqual({ operaUserMappings: { OP1: "Original" } });
  });

  it("validates IDs and bounded fields before writes", async () => {
    await expect(createCatalogCategory("hotel", { name: "x".repeat(201) })).rejects.toThrow("200");
    await expect(createCatalogSubcategory("hotel", { name: "Child", categoryId: "bad/id" })).rejects.toThrow("Category ID");
    await expect(createOperaUserMapping("hotel", { operaUser: "x".repeat(129), employeeName: "Employee" })).rejects.toThrow("128");
    await expect(createOperaUserMapping("hotel", { operaUser: "bad/id", employeeName: "Employee" })).rejects.toThrow("Opera username");
    expect(mocks.setDoc).not.toHaveBeenCalled();
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });
});
