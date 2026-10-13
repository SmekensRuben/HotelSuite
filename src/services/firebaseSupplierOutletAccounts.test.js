import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: { currentUser: { uid: "manager" } }, call: vi.fn(), getDocs: vi.fn(), query: vi.fn((...args) => args), where: vi.fn((...args) => args) }));
vi.mock("../firebaseConfig", () => ({ auth: mocks.auth, db: {}, functions: {}, collection: (_db, path) => path, getDocs: mocks.getDocs, query: mocks.query, where: mocks.where,
  httpsCallable: (_functions, name) => { expect(name).toBe("saveSupplierOutletAccount"); return mocks.call; } }));
import { createSupplierOutletAccount, getSupplierOutletAccounts, updateSupplierOutletAccount } from "./firebaseSuppliers";
const account = { id: "legacy", supplierId: "supplier", outletId: "bar", accountNumber: "OLD" };
beforeEach(() => { vi.clearAllMocks(); mocks.auth.currentUser = { uid: "manager" }; mocks.call.mockResolvedValue({ data: { id: "legacy", revision: 1 } }); });
it("issues an explicit create and revision-guarded legacy update without accepting spoofed names/audit metadata", async () => {
  await createSupplierOutletAccount("hotel-a", { ...account, supplierName: "SPOOF", updatedBy: "SPOOF" });
  expect(mocks.call).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 0, expectedActorUid: "manager" }));
  expect(mocks.call.mock.calls[0][0]).not.toHaveProperty("accountId"); expect(mocks.call.mock.calls[0][0]).not.toHaveProperty("updatedBy");
  await updateSupplierOutletAccount("hotel-a", account, "NEW");
  expect(mocks.call).toHaveBeenLastCalledWith(expect.objectContaining({ accountId: "legacy", supplierId: "supplier", outletId: "bar", expectedRevision: 0, accountNumber: "NEW" }));
});
it("reuses the exact operation after an uncertain response and drops stale/conflicting commands", async () => {
  mocks.call.mockRejectedValueOnce(Object.assign(new Error("Timeout"), { code: "functions/unavailable" }));
  await expect(updateSupplierOutletAccount("hotel-a", account, "NEW")).rejects.toThrow("Timeout");
  await updateSupplierOutletAccount("hotel-a", account, "NEW"); expect(mocks.call.mock.calls[0][0]).toEqual(mocks.call.mock.calls[1][0]);
  mocks.call.mockRejectedValueOnce(Object.assign(new Error("Conflict"), { code: "functions/aborted" }));
  await expect(updateSupplierOutletAccount("hotel-a", account, "NEW")).rejects.toThrow("Conflict"); await updateSupplierOutletAccount("hotel-a", account, "NEW");
  expect(mocks.call.mock.calls[2][0].requestId).not.toBe(mocks.call.mock.calls[3][0].requestId);
});
it("queries the supplier on the server and rejects an unverified cached account list", async () => {
  mocks.getDocs.mockResolvedValue({ docs: [{ id: "legacy", data: () => ({ ...account, id: "SPOOF" }) }], metadata: { fromCache: false } });
  expect((await getSupplierOutletAccounts("hotel-a", { supplierId: "supplier" }))[0].id).toBe("legacy");
  expect(mocks.where).toHaveBeenCalledWith("supplierId", "==", "supplier"); expect(mocks.query).toHaveBeenCalled();
  mocks.getDocs.mockResolvedValue({ docs: [], metadata: { fromCache: true } });
  await expect(getSupplierOutletAccounts("hotel-a", { supplierId: "supplier" })).rejects.toThrow(/verified/);
});
it("does not accept a late response for a different Auth object with the same UID", async () => {
  let resolve; mocks.call.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const pending = updateSupplierOutletAccount("hotel-a", account, "NEW"); mocks.auth.currentUser = { uid: "manager" }; resolve({ data: { id: "legacy", revision: 1 } });
  await expect(pending).rejects.toThrow(/signed-in account changed/);
});
it("keeps malformed or older-backend acknowledgements uncertain instead of reporting a verified save", async () => {
  mocks.call.mockResolvedValueOnce({ data: { id: "legacy" } });
  await expect(updateSupplierOutletAccount("hotel-a", account, "NEW")).rejects.toThrow(/could not be verified/);
  await updateSupplierOutletAccount("hotel-a", account, "NEW");
  expect(mocks.call.mock.calls[0][0]).toEqual(mocks.call.mock.calls[1][0]);
  mocks.call.mockResolvedValueOnce({ data: { id: "other", revision: 1 } });
  await expect(updateSupplierOutletAccount("hotel-a", account, "NEW")).rejects.toThrow(/could not be verified/);
});
