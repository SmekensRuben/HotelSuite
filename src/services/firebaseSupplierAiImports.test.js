import { webcrypto } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: { currentUser: null }, fetch: vi.fn(), callable: vi.fn() }));
vi.mock("../firebaseConfig", () => ({ auth: mocks.auth, functions: { app: { options: { projectId: "demo-hotel-suite-a00" } } }, httpsCallable: (_, name) => (input) => mocks.callable(name, input) }));
import { getSupplierAiImportAvailability, startSupplierAiImport, getSupplierAiImport, validateSupplierAiImportFile, getSupplierAiImportReview, saveSupplierAiImportReview, confirmSupplierAiImport } from "./firebaseSupplierAiImports";
import { invalidateProcurementReads } from "./procurementReadPool";
const response = (data) => ({ ok: true, json: async () => data });
const saved = { hotelUid: "hotel-a", supplierId: "supplier", ownerUid: "manager", jobId: "job", status: "queued" };
const file = (content = "SKU,Name\n001,Coffee") => new File([content], "supplier.csv", { type: "text/csv" });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); invalidateProcurementReads(); mocks.auth.currentUser = { uid: "manager", getIdToken: vi.fn(async () => "fictional-token") }; vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("fetch", mocks.fetch); mocks.fetch.mockResolvedValue(response(saved)); });
it("uploads privately to the configured HTTP endpoint with no key or token in its URL", async () => {
  const selected = file(); expect(await startSupplierAiImport("hotel-a", "supplier", selected)).toEqual(saved);
  const [url, init] = mocks.fetch.mock.calls[0], query = new URL(url).searchParams;
  expect(query.get("hotelUid")).toBe("hotel-a"); expect(query.get("supplierId")).toBe("supplier"); expect(query.get("mimeType")).toBe("text/csv"); expect(query.get("fileName")).toBe("supplier.csv");
  expect(url).not.toContain("fictional-token"); expect(init.headers.Authorization).toBe("Bearer fictional-token"); expect(init.headers["Content-Type"]).toBe("application/octet-stream"); expect(init.body).toBe(selected); expect(init.cache).toBe("no-store"); expect(init.credentials).toBe("omit");
});
it("rejects oversized, empty, unsupported or unsafe file names before any request", async () => {
  for (const value of [null, new File([], "empty.pdf"), file(""), { name: "huge.pdf", size: 10485761 }, { name: "unsupported.xls", size: 10 }, { name: "path/file.csv", size: 10 }]) {
    expect(() => validateSupplierAiImportFile(value)).toThrow(); await expect(startSupplierAiImport("hotel-a", "supplier", value)).rejects.toThrow();
  }
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it("recovers an ambiguous upload using its original request for the same file bytes, including reselection", async () => {
  const selected = file(); mocks.fetch.mockRejectedValueOnce(new Error("Connection lost"));
  await expect(startSupplierAiImport("hotel-a", "supplier", selected)).rejects.toThrow("Connection lost");
  const stored = Object.values(sessionStorage); expect(stored.join("")).not.toContain("Coffee"); expect(stored.join("")).not.toContain("fictional-token");
  await startSupplierAiImport("hotel-a", "supplier", new File(["SKU,Name\n001,Coffee"], "renamed.csv", { type: "text/csv" }));
  expect(mocks.fetch.mock.calls[0][0]).toBe(mocks.fetch.mock.calls[1][0]);
  expect(sessionStorage.length).toBe(1); expect(JSON.parse(sessionStorage.getItem("supplier-ai-import:hotel-a:manager"))).toEqual({ jobId: "job" });
});
it("does not silently accept a cross-hotel, cross-supplier or wrong-owner upload acknowledgement", async () => {
  for (const patch of [{ hotelUid: "hotel-b" }, { supplierId: "other" }, { ownerUid: "other" }]) {
    mocks.fetch.mockResolvedValueOnce(response({ ...saved, ...patch })); await expect(startSupplierAiImport("hotel-a", "supplier", file())).rejects.toThrow(/acknowledgement/);
  }
});
it("shares availability and job reads, and exposes disabled settings with fallback fixed off", async () => {
  mocks.fetch.mockResolvedValueOnce(response({ available: false, model: "gpt-6-luna", fallbackEnabled: false, reason: "disabled" }));
  const result = await Promise.all([getSupplierAiImportAvailability("hotel-a"), getSupplierAiImportAvailability("hotel-a")]); expect(result[0].available).toBe(false); expect(mocks.fetch).toHaveBeenCalledTimes(1);
  mocks.fetch.mockResolvedValue(response(saved)); await Promise.all([getSupplierAiImport("hotel-a", "job"), getSupplierAiImport("hotel-a", "job")]); expect(mocks.fetch).toHaveBeenCalledTimes(2);
  mocks.fetch.mockResolvedValueOnce(response({ available: true, fallbackEnabled: true })); await expect(getSupplierAiImportAvailability("hotel-a")).rejects.toThrow(/settings/);
});
it("rejects late reads and uploads after Auth replacement with the same UID or invalidated hotel access", async () => {
  const pending = deferred(); mocks.fetch.mockReturnValueOnce(pending.promise);
  const running = getSupplierAiImport("hotel-a", "job"); await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
  mocks.auth.currentUser = { uid: "manager", getIdToken: vi.fn() }; pending.resolve(response(saved)); await expect(running).rejects.toThrow(/access changed/);
  mocks.auth.currentUser = { uid: "manager", getIdToken: vi.fn(async () => "token") }; const next = deferred(); mocks.fetch.mockReturnValueOnce(next.promise);
  const upload = startSupplierAiImport("hotel-a", "supplier", file()); await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2)); invalidateProcurementReads("hotel-a"); next.resolve(response(saved)); await expect(upload).rejects.toThrow(/access changed/);
});
it("uses only protected review and correction callables, verifying tenant and job acknowledgements", async () => {
  mocks.callable.mockResolvedValueOnce({ data: { hotelUid: "hotel-a", jobId: "job", rows: [], totalRows: 0, nextCursor: null } });
  await getSupplierAiImportReview("hotel-a", "job", "row-25"); expect(mocks.callable).toHaveBeenCalledWith("readHotelSupplierAiImportRows", { hotelUid: "hotel-a", jobId: "job", cursor: "row-25", limit: 25 });
  mocks.callable.mockResolvedValueOnce({ data: { hotelUid: "hotel-b", jobId: "job", row: {} } }); await expect(saveSupplierAiImportReview("hotel-a", { jobId: "job", rowId: "row", expectedReviewRevision: 1, patch: { currency: "EUR" } })).rejects.toThrow(/response/);
});
it("commits at most 25 explicitly reviewed rows per request and resumes the original failed batch", async () => {
  const selected = Array.from({ length: 60 }, (_, index) => ({ rowId: `row-${index}`, reviewRevision: 1, acknowledged: true }));
  mocks.callable.mockImplementation(async (_, input) => ({ data: { hotelUid: input.hotelUid, jobId: input.jobId, complete: true, outcomes: input.rows.map((row) => ({ rowId: row.rowId, status: "created", productId: row.rowId, revision: 1 })) } }));
  mocks.callable.mockImplementationOnce(async (_, input) => ({ data: { hotelUid: input.hotelUid, jobId: input.jobId, complete: true, outcomes: input.rows.map((row) => ({ rowId: row.rowId, status: "created", productId: row.rowId, revision: 1 })) } })).mockRejectedValueOnce(new Error("Acknowledgement lost"));
  await expect(confirmSupplierAiImport("hotel-a", "job", selected)).rejects.toThrow("Acknowledgement lost");
  const result = await confirmSupplierAiImport("hotel-a", "job", selected); expect(result.outcomes).toHaveLength(60); expect(mocks.callable.mock.calls.map(([, input]) => input.rows.length)).toEqual([25, 25, 25, 10]); expect(mocks.callable.mock.calls[1][1]).toEqual(mocks.callable.mock.calls[2][1]);
});
it("rejects unreviewed selections and incomplete acknowledgements without losing the original operation", async () => {
  await expect(confirmSupplierAiImport("hotel-a", "job", [{ rowId: "row", reviewRevision: 1, acknowledged: false }])).rejects.toThrow(/reviewed/); expect(mocks.callable).not.toHaveBeenCalled();
  const selected = [{ rowId: "row", reviewRevision: 1, acknowledged: true }]; mocks.callable.mockResolvedValueOnce({ data: { hotelUid: "hotel-a", jobId: "job", complete: true, outcomes: [] } }); await expect(confirmSupplierAiImport("hotel-a", "job", selected)).rejects.toThrow(/incomplete/);
  mocks.callable.mockResolvedValueOnce({ data: { hotelUid: "hotel-a", jobId: "job", complete: true, outcomes: [{ rowId: "row", status: "blocked", error: { message: "Product changed" } }] } }); expect((await confirmSupplierAiImport("hotel-a", "job", selected)).outcomes[0].status).toBe("blocked"); expect(mocks.callable.mock.calls[0][1].requestId).toBe(mocks.callable.mock.calls[1][1].requestId);
});
