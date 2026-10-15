import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: { currentUser: null }, call: vi.fn(), endpoint: vi.fn(), fetch: vi.fn() }));
vi.mock("../firebaseConfig", () => ({ auth: mocks.auth, functions: { app: { options: { projectId: "hotel-toolkit-test" } } }, httpsCallable: (_, endpoint) => { mocks.endpoint(endpoint); return mocks.call; } }));
import { invalidateProcurementReads } from "./procurementReadPool";
import { decideProductProposalImage, getPendingProductProposalImageAction, getProductProposalImage, prepareProductProposalImage, retryProductProposalImageAction, uploadProductProposalImage } from "./firebaseProductProposalImages";

const image = (overrides = {}) => ({ assetId: "a".repeat(64), status: "ready", selection: "unselected", decisionRevision: 0, sourceUrl: "https://supplier.example/image.webp", sourcePageUrl: null, mimeType: "image/webp", width: 640, height: 480, error: null, currentImage: { assetId: null, status: "none", imageRevision: 0 }, attachment: { status: "none", productId: null, imageRevision: null, error: null }, ...overrides });
const ack = (input, overrides = {}) => ({ hotelUid: input.hotelUid, batchId: input.batchId, rowId: input.rowId, batchRevision: 2, image: image(overrides) });
beforeEach(() => { vi.clearAllMocks(); invalidateProcurementReads(); mocks.auth.currentUser = { uid: "owner", getIdToken: vi.fn().mockResolvedValue("private-token") }; vi.stubGlobal("fetch", mocks.fetch); });
afterEach(() => { vi.unstubAllGlobals(); });

it("prepares a URL through the protected callable and preserves its exact retry identity", async () => {
  mocks.call.mockRejectedValueOnce(new Error("Acknowledgement lost")).mockImplementation(async (input) => ({ data: ack(input) }));
  await expect(prepareProductProposalImage("hotel-a", "batch-1", "row-1", { imageUrl: "https://supplier.example/image.webp?signature=original", sourcePageUrl: "https://supplier.example/item" })).rejects.toThrow("Acknowledgement lost");
  await retryProductProposalImageAction("hotel-a", "batch-1", "row-1");
  expect(mocks.endpoint).toHaveBeenCalledWith("prepareHotelMcpProposalImage"); expect(mocks.call.mock.calls[1][0]).toEqual(mocks.call.mock.calls[0][0]); expect(getPendingProductProposalImageAction("hotel-a", "batch-1", "row-1")).toBeNull(); expect(mocks.fetch).not.toHaveBeenCalled();
});
it("refuses another source while an image action is uncertain", async () => {
  mocks.call.mockRejectedValue(new Error("Offline"));
  await expect(prepareProductProposalImage("hotel-a", "batch-1", "row-1", { imageUrl: "https://supplier.example/one.webp" })).rejects.toThrow("Offline");
  await expect(prepareProductProposalImage("hotel-a", "batch-1", "row-1", { imageUrl: "https://supplier.example/two.webp" })).rejects.toThrow("Retry the original"); expect(mocks.call).toHaveBeenCalledTimes(1);
});
it("sends uploaded bytes only to the authenticated native endpoint", async () => {
  const file = new File(["pixels"], "milk.png", { type: "image/png" });
  mocks.fetch.mockImplementation(async (url) => ({ ok: true, json: async () => ack(Object.fromEntries(new URL(url).searchParams)) }));
  await uploadProductProposalImage("hotel-a", "batch-1", "row-1", file);
  const [url, options] = mocks.fetch.mock.calls[0]; expect(url).toContain("https://us-central1-hotel-toolkit-test.cloudfunctions.net/hotelMcpProposalImage?"); expect(options).toMatchObject({ method: "POST", headers: { Authorization: "Bearer private-token", "Content-Type": "application/octet-stream" }, body: file, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" }); expect(mocks.call).not.toHaveBeenCalled();
});
it("rejects unsafe URLs and unsupported files before contacting a backend", async () => {
  await expect(prepareProductProposalImage("hotel-a", "batch-1", "row-1", { imageUrl: "http://supplier.example/image.png" })).rejects.toThrow("HTTPS"); await expect(prepareProductProposalImage("hotel-a", "batch-1", "row-1", { imageUrl: "https://user:password@supplier.example/image.png" })).rejects.toThrow("HTTPS");
  await expect(uploadProductProposalImage("hotel-a", "batch-1", "row-1", new File(["svg"], "image.svg", { type: "image/svg+xml" }))).rejects.toThrow("JPEG, PNG or WebP"); expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.call).not.toHaveBeenCalled();
});
it("requires a reviewed image revision for replacement and retries private sources by asset only", async () => {
  await expect(decideProductProposalImage("hotel-a", "batch-1", "row-1", { assetId: image().assetId, expectedBatchRevision: 3, action: "select", replaceExisting: true })).rejects.toThrow("revision");
  mocks.call.mockImplementation(async (input) => ({ data: ack(input, { selection: "selected", decisionRevision: 1 }) }));
  await decideProductProposalImage("hotel-a", "batch-1", "row-1", { assetId: image().assetId, expectedBatchRevision: 3, action: "select", replaceExisting: true, expectedImageRevision: 7 });
  expect(mocks.call.mock.calls[0][0]).toMatchObject({ expectedBatchRevision: 3, action: "select", replaceExisting: true, expectedImageRevision: 7 });
  await decideProductProposalImage("hotel-a", "batch-1", "row-1", { assetId: image().assetId, expectedBatchRevision: 4, action: "retry" }); expect(mocks.call.mock.calls[1][0]).toMatchObject({ action: "retry", assetId: image().assetId }); expect(mocks.call.mock.calls[1][0]).not.toHaveProperty("imageUrl");
});
it("reads only private WebP previews with bearer authorization and rejects other content", async () => {
  mocks.fetch.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["preview"], { type: "image/webp" }) }).mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["wrong"], { type: "image/png" }) });
  await getProductProposalImage("hotel-a", "batch-1", "row-1", image(), "display");
  const [url, options] = mocks.fetch.mock.calls[0]; expect(new URL(url).hostname).toBe("us-central1-hotel-toolkit-test.cloudfunctions.net"); expect(options.headers.Authorization).toBe("Bearer private-token"); expect(options.cache).toBe("no-store");
  await expect(getProductProposalImage("hotel-a", "batch-1", "row-1", image(), "thumbnail")).rejects.toThrow("preview could not be verified");
});
it("rejects cross-hotel acknowledgements and isolates pending actions between accounts", async () => {
  mocks.call.mockImplementation(async (input) => ({ data: { ...ack(input), hotelUid: "hotel-b" } }));
  await expect(prepareProductProposalImage("hotel-a", "batch-1", "row-1", { imageUrl: "https://supplier.example/image.webp" })).rejects.toThrow("acknowledgement"); expect(getPendingProductProposalImageAction("hotel-a", "batch-1", "row-1")).not.toBeNull();
  mocks.auth.currentUser = { uid: "other", getIdToken: vi.fn() }; expect(getPendingProductProposalImageAction("hotel-a", "batch-1", "row-1")).toBeNull();
});
it("discards delayed image bytes after the authenticated identity changes", async () => {
  let resolve; mocks.fetch.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const result = getProductProposalImage("hotel-a", "batch-1", "row-1", image()); await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
  mocks.auth.currentUser = { uid: "owner", getIdToken: vi.fn() }; resolve({ ok: true, blob: async () => new Blob(["preview"], { type: "image/webp" }) }); await expect(result).rejects.toThrow("Hotel access changed");
});
it("retains an image preparation receipt while the server is still processing it", async () => {
  mocks.call.mockImplementationOnce(async (input) => ({ data: ack(input, { status: "preparing" }) })).mockImplementationOnce(async (input) => ({ data: ack(input) }));
  await prepareProductProposalImage("hotel-a", "batch-1", "row-1", { imageUrl: "https://supplier.example/image.webp" }); expect(getPendingProductProposalImageAction("hotel-a", "batch-1", "row-1")).not.toBeNull();
  await retryProductProposalImageAction("hotel-a", "batch-1", "row-1"); expect(mocks.call.mock.calls[1][0]).toEqual(mocks.call.mock.calls[0][0]); expect(getPendingProductProposalImageAction("hotel-a", "batch-1", "row-1")).toBeNull();
});
