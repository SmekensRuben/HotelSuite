import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: { currentUser: null }, fetch: vi.fn() }));
vi.mock("../firebaseConfig", () => ({ auth: mocks.auth, functions: { app: { options: { projectId: "demo-hotel-suite-a00" } } } }));
import { getSupplierProductImage, uploadSupplierProductImage, validateSupplierImageFile } from "./firebaseSupplierProductImages";
import { invalidateProcurementReads } from "./procurementReadPool";
const assetId = "a".repeat(64), product = { id: "coffee", imageRevision: 0, image: { assetId, status: "ready" } };
const file = () => new File(["fictional-image"], "coffee.png", { type: "image/png" });
const response = (data) => ({ ok: true, json: async () => data });
const saved = { hotelUid: "hotel-a", productId: "coffee", assetId, imageRevision: 1, status: "ready" };
beforeEach(() => { vi.clearAllMocks(); invalidateProcurementReads(); mocks.auth.currentUser = { uid: "manager", getIdToken: vi.fn(async () => "fictional-token") }; vi.stubGlobal("fetch", mocks.fetch); mocks.fetch.mockResolvedValue(response(saved)); });
it("uploads binary to the configured protected endpoint, without putting credentials in a URL", async () => {
  const selected = file(); expect(await uploadSupplierProductImage("hotel-a", product, selected)).toEqual(saved);
  const [url, init] = mocks.fetch.mock.calls[0], query = new URL(url).searchParams;
  expect(query.get("hotelUid")).toBe("hotel-a"); expect(query.get("productId")).toBe("coffee"); expect(query.get("expectedImageRevision")).toBe("0");
  expect(url).not.toContain("fictional-token"); expect(init.headers.Authorization).toBe("Bearer fictional-token"); expect(init.headers["Content-Type"]).toBe("application/octet-stream");
  expect(init.body).toBe(selected); expect(init.cache).toBe("no-store"); expect(init.credentials).toBe("omit");
});
it("bounds file types and bytes before making a request", async () => {
  for (const value of [null, new File([], "empty.png", { type: "image/png" }), new File(["svg"], "x.svg", { type: "image/svg+xml" }), { size: 5242881, type: "image/png" }]) {
    expect(() => validateSupplierImageFile(value)).toThrow(); await expect(uploadSupplierProductImage("hotel-a", product, value)).rejects.toThrow();
  }
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it("reuses an uncertain upload's exact request and drops explicitly rejected requests", async () => {
  const selected = file(); mocks.fetch.mockRejectedValueOnce(new Error("Connection lost"));
  await expect(uploadSupplierProductImage("hotel-a", product, selected)).rejects.toThrow("Connection lost"); await uploadSupplierProductImage("hotel-a", product, selected);
  expect(mocks.fetch.mock.calls[0][0]).toEqual(mocks.fetch.mock.calls[1][0]);
  mocks.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: { code: "aborted", message: "Image changed" } }) });
  await expect(uploadSupplierProductImage("hotel-a", product, selected)).rejects.toThrow("Image changed"); await uploadSupplierProductImage("hotel-a", product, selected);
  expect(mocks.fetch.mock.calls[2][0]).not.toEqual(mocks.fetch.mock.calls[3][0]);
});
it("does not accept wrong-scope acknowledgements, and preserves failed/pending preparation explicitly", async () => {
  const selected = file(); mocks.fetch.mockResolvedValueOnce(response({ ...saved, hotelUid: "hotel-b" }));
  await expect(uploadSupplierProductImage("hotel-a", product, selected)).rejects.toThrow(/acknowledgement/);
  mocks.fetch.mockResolvedValueOnce(response({ ...saved, status: "failed", error: { code: "invalid-image" } }));
  expect((await uploadSupplierProductImage("hotel-a", product, selected)).status).toBe("failed");
  mocks.fetch.mockResolvedValueOnce(response({ ...saved, status: "pending" })); expect((await uploadSupplierProductImage("hotel-a", product, file())).status).toBe("pending");
});
it("shares concurrent private image reads and requires a bounded WebP response", async () => {
  const blob = new Blob(["fictional-webp"], { type: "image/webp" }); mocks.fetch.mockResolvedValue({ ok: true, blob: async () => blob });
  const results = await Promise.all([getSupplierProductImage("hotel-a", product), getSupplierProductImage("hotel-a", product)]);
  expect(results).toEqual([blob, blob]); expect(mocks.fetch).toHaveBeenCalledTimes(1); expect(new URL(mocks.fetch.mock.calls[0][0]).searchParams.get("assetId")).toBe(assetId);
  mocks.fetch.mockResolvedValue({ ok: true, blob: async () => new Blob(["error"], { type: "text/html" }) }); await expect(getSupplierProductImage("hotel-a", product)).rejects.toThrow(/invalid/);
});
it("rejects late reads/uploads after actual Auth replacement even with the same UID", async () => {
  let resolve; mocks.fetch.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const pending = uploadSupplierProductImage("hotel-a", product, file()); await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
  mocks.auth.currentUser = { uid: "manager", getIdToken: vi.fn() }; resolve(response(saved)); await expect(pending).rejects.toThrow(/access changed/);
});
it("retains valid legacy product identities in encoded image requests", async () => {
  const legacy = { ...product, id: "coffee.offer v1" }; mocks.fetch.mockResolvedValueOnce(response({ ...saved, productId: legacy.id }));
  await uploadSupplierProductImage("hotel-a", legacy, file());
  expect(new URL(mocks.fetch.mock.calls[0][0]).searchParams.get("productId")).toBe(legacy.id);
});
