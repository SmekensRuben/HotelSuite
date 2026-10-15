import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: { currentUser: null }, fetch: vi.fn() }));
vi.mock("../firebaseConfig", () => ({ functions: { app: { options: { projectId: "hotel-test" } } }, auth: mocks.auth }));
import { invalidateProcurementReads } from "./procurementReadPool";
import { uploadPurchaseRequestAttachment, downloadPurchaseRequestAttachment } from "./firebasePurchaseRequestAttachments";
beforeEach(() => {
  vi.clearAllMocks(); invalidateProcurementReads();
  mocks.auth.currentUser = { uid: "requester", getIdToken: vi.fn().mockResolvedValue("fictional-token") };
  vi.stubGlobal("fetch", mocks.fetch);
});
const file = () => new File(["Quote"], "quote.txt", { type: "text/plain", lastModified: 1 });
it("uploads to the authorized binary endpoint and preserves an interrupted upload ID", async () => {
  const quote = file();
  mocks.fetch.mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce({ ok: true, json: async () => ({ attachment: { fileId: "ready" }, revision: 1 }) });
  await expect(uploadPurchaseRequestAttachment("hotel-a", "request-a", quote, 1)).rejects.toThrow("Offline");
  await uploadPurchaseRequestAttachment("hotel-a", "request-a", quote, 1);
  const first = new URL(mocks.fetch.mock.calls[0][0]), second = new URL(mocks.fetch.mock.calls[1][0]);
  expect(first.searchParams.get("fileId")).toBe(second.searchParams.get("fileId"));
  expect(first.searchParams.get("hotelUid")).toBe("hotel-a");
  expect(first.searchParams.get("expectedRevision")).toBe("1");
  expect(mocks.fetch.mock.calls[1][1]).toEqual({ method: "POST", headers: { Authorization: "Bearer fictional-token", "Content-Type": "application/octet-stream" }, body: quote, cache: "no-store" });
});
it("rejects unsaved, empty, oversized and unsupported uploads before opening a request", async () => {
  for (const [id, quote, revision] of [[null, file(), 1], ["request-a", file(), 0], ["request-a", new File([], "empty.txt"), 1], ["request-a", new File(["execute"], "unsafe.exe"), 1], ["request-a", { name: "quote.pdf", size: 10 * 1024 * 1024 + 1 }, 1]]) await expect(uploadPurchaseRequestAttachment("hotel-a", id, quote, revision)).rejects.toThrow();
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it("downloads a historical attachment as private Blob data without durable public URLs", async () => {
  const blob = new Blob(["quote"]); mocks.fetch.mockResolvedValue({ ok: true, blob: async () => blob });
  expect(await downloadPurchaseRequestAttachment("hotel-a", "request-a", { fileId: "attachment" }, 2)).toBe(blob);
  const url = new URL(mocks.fetch.mock.calls[0][0]);
  expect(url.searchParams.get("revision")).toBe("2"); expect(url.searchParams.has("token")).toBe(false);
});
it("drops downloaded bytes when the account instance or hotel authority changes", async () => {
  let resolve; mocks.fetch.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const reading = downloadPurchaseRequestAttachment("hotel-a", "request-a", { fileId: "attachment" });
  await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
  invalidateProcurementReads("hotel-a"); resolve({ ok: true, blob: async () => new Blob(["private"]) });
  await expect(reading).rejects.toThrow("hotel access changed");
});
