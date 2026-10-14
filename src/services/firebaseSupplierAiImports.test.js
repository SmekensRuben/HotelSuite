import { webcrypto } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: { currentUser: null }, fetch: vi.fn(), callable: vi.fn() }));
vi.mock("../firebaseConfig", () => ({ auth: mocks.auth, functions: { app: { options: { projectId: "demo-hotel-suite-a00" } } }, httpsCallable: (_, name) => (input) => mocks.callable(name, input) }));
import { getSupplierAiImportAvailability, startSupplierAiImport, getSupplierAiImport, validateSupplierAiImportFile, getSupplierAiImportReview, saveSupplierAiImportReview, confirmSupplierAiImport, normalizeSupplierAiImportSettings, normalizeSupplierAiImportSummary, supplierAiImportVatFraction } from "./firebaseSupplierAiImports";
import { invalidateProcurementReads } from "./procurementReadPool";
const response = (data) => ({ ok: true, json: async () => data });
const availability = { available: true, importPolicyVersion: 2, reason: null, defaults: { currency: "EUR" } };
const postCalls = () => mocks.fetch.mock.calls.filter(([, input]) => input?.method === "POST");
const acknowledgeUpload = (value) => mocks.fetch.mockResolvedValueOnce(response(availability)).mockResolvedValueOnce(response(value));
const loseUpload = (error) => mocks.fetch.mockResolvedValueOnce(response(availability)).mockRejectedValueOnce(error);
const settings = { policyVersion: 2, priceBasis: "net", currency: "EUR", vatRate: null };
const saved = { hotelUid: "hotel-a", supplierId: "supplier", ownerUid: "manager", jobId: "job", status: "queued", importSettings: settings, summary: null };
const file = (content = "SKU,Name\n001,Coffee") => new File([content], "supplier.csv", { type: "text/csv" });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); invalidateProcurementReads(); mocks.auth.currentUser = { uid: "manager", getIdToken: vi.fn(async () => "fictional-token") }; vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("fetch", mocks.fetch); mocks.fetch.mockImplementation(async (url, input) => response(input?.method === "GET" && !new URL(url).searchParams.has("jobId") ? availability : saved)); });
it("uploads privately to the configured HTTP endpoint with no key or token in its URL", async () => {
  const selected = file(); expect(await startSupplierAiImport("hotel-a", "supplier", selected, settings)).toEqual(saved);
  const [url, init] = postCalls()[0], query = new URL(url).searchParams;
  expect(query.get("hotelUid")).toBe("hotel-a"); expect(query.get("supplierId")).toBe("supplier"); expect(query.get("mimeType")).toBe("text/csv"); expect(query.get("fileName")).toBe("supplier.csv");
  expect(url).not.toContain("fictional-token"); expect(init.headers.Authorization).toBe("Bearer fictional-token"); expect(init.headers["Content-Type"]).toBe("application/octet-stream"); expect(init.body).toBe(selected); expect(init.cache).toBe("no-store"); expect(init.credentials).toBe("omit");
});
it("rejects oversized, empty, unsupported or unsafe file names before any request", async () => {
  for (const value of [null, new File([], "empty.pdf"), file(""), { name: "huge.pdf", size: 10485761 }, { name: "unsupported.xls", size: 10 }, { name: "path/file.csv", size: 10 }]) {
    expect(() => validateSupplierAiImportFile(value)).toThrow(); await expect(startSupplierAiImport("hotel-a", "supplier", value, settings)).rejects.toThrow();
  }
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it("recovers an ambiguous upload using its original request for the same file bytes, including reselection", async () => {
  const selected = file(); loseUpload(new Error("Connection lost"));
  await expect(startSupplierAiImport("hotel-a", "supplier", selected, settings)).rejects.toThrow("Connection lost");
  const stored = Object.values(sessionStorage); expect(stored.join("")).not.toContain("Coffee"); expect(stored.join("")).not.toContain("fictional-token");
  await startSupplierAiImport("hotel-a", "supplier", new File(["SKU,Name\n001,Coffee"], "renamed.csv", { type: "text/csv" }), settings);
  expect(postCalls()[0][0]).toBe(postCalls()[1][0]);
  expect(sessionStorage.length).toBe(1); expect(JSON.parse(sessionStorage.getItem("supplier-ai-import:hotel-a:manager"))).toEqual({ jobId: "job" });
});
it("does not silently accept a cross-hotel, cross-supplier or wrong-owner upload acknowledgement", async () => {
  for (const patch of [{ hotelUid: "hotel-b" }, { supplierId: "other" }, { ownerUid: "other" }]) {
    acknowledgeUpload({ ...saved, ...patch }); await expect(startSupplierAiImport("hotel-a", "supplier", file(), settings)).rejects.toThrow(/acknowledgement/);
  }
});
it("shares availability and job reads without exposing provider or accounting configuration", async () => {
  mocks.fetch.mockResolvedValueOnce(response({ available: false, model: "gpt-6-luna", fallbackEnabled: false, reason: "disabled" }));
  const result = await Promise.all([getSupplierAiImportAvailability("hotel-a"), getSupplierAiImportAvailability("hotel-a")]); expect(result[0].available).toBe(false); expect(mocks.fetch).toHaveBeenCalledTimes(1);
  mocks.fetch.mockResolvedValue(response(saved)); await Promise.all([getSupplierAiImport("hotel-a", "job"), getSupplierAiImport("hotel-a", "job")]); expect(mocks.fetch).toHaveBeenCalledTimes(2);
  mocks.fetch.mockResolvedValueOnce(response({ available: true, reason: "unknown" })); await expect(getSupplierAiImportAvailability("hotel-a")).rejects.toThrow(/settings/);
});
it("rejects late reads and uploads after Auth replacement with the same UID or invalidated hotel access", async () => {
  const pending = deferred(); mocks.fetch.mockReturnValueOnce(pending.promise);
  const running = getSupplierAiImport("hotel-a", "job"); await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
  mocks.auth.currentUser = { uid: "manager", getIdToken: vi.fn() }; pending.resolve(response(saved)); await expect(running).rejects.toThrow(/access changed/);
  mocks.auth.currentUser = { uid: "manager", getIdToken: vi.fn(async () => "token") }; const next = deferred(); mocks.fetch.mockResolvedValueOnce(response(availability)).mockReturnValueOnce(next.promise);
  const upload = startSupplierAiImport("hotel-a", "supplier", file(), settings); await vi.waitFor(() => expect(postCalls()).toHaveLength(1)); invalidateProcurementReads("hotel-a"); next.resolve(response(saved)); await expect(upload).rejects.toThrow(/access changed/);
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

it("projects customer job and availability data even when an older server sends financial details", async () => {
  mocks.fetch.mockResolvedValueOnce(response({ available: true, importPolicyVersion: 2, reason: null, model: "gpt-6-luna", fallbackEnabled: true, configuration: { maxMonthlyCostPerHotelUsd: 10 }, limits: { maxFileBytes: 10485760, maxPages: 50, maxProducts: 1000, maxCostPerImportUsd: 0.25 } }));
  expect(await getSupplierAiImportAvailability("hotel-a")).toEqual({ available: true, importPolicyVersion: 2, reason: null, limits: { maxFileBytes: 10485760, maxPages: 50, maxProducts: 1000 }, defaults: { currency: null } });
  mocks.fetch.mockResolvedValueOnce(response({ ...saved, model: "gpt-6-luna", usage: { actualCostUsd: 0.01, reservedCostUsd: 0.1 }, configuration: { maxCostPerImportUsd: 0.25 }, progress: { completedChunks: 2, totalChunks: 4 }, source: { fileName: "supplier.csv", size: 20, mimeType: "text/csv", privatePath: "private-source", costUsd: 4 }, error: { code: "resource-exhausted", message: "USD 0.25 budget exhausted", costUsd: 2 }, warnings: [{ code: "limit", message: "Token budget reached", costUsd: 2 }] }));
  const received = await getSupplierAiImport("hotel-a", "job"), serialized = JSON.stringify(received);
  expect(received.progress).toEqual({ completedChunks: 2, totalChunks: 4 });
  for (const forbidden of ["gpt-6-luna", "usage", "configuration", "Cost", "costUsd", "USD", "Token", "budget", "private-source"]) expect(serialized).not.toContain(forbidden);
  expect(received.source).toEqual({ fileName: "supplier.csv", size: 20, mimeType: "text/csv" });
});
it("rejects forged progress and shields internal HTTP/callable errors from hotel users", async () => {
  mocks.fetch.mockResolvedValueOnce(response({ ...saved, progress: { completedChunks: 3, totalChunks: 2 } })); await expect(getSupplierAiImport("hotel-a", "job")).rejects.toThrow(/progress/);
  for (const message of ["AI budget USD 0.25 exceeded", "model gpt-6-luna failed", "reserved amount 0.25", "Provider configuration rejected", "maxCostPerImportUsd exceeded"]) { mocks.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: { code: "resource-exhausted", message } }) }); await expect(getSupplierAiImport("hotel-a", "job")).rejects.toThrow("Contact your hotel administrator"); }
  mocks.callable.mockRejectedValueOnce(Object.assign(new Error("OpenAI token cost $0.01"), { code: "functions/resource-exhausted" })); await expect(getSupplierAiImportReview("hotel-a", "job")).rejects.toThrow("Contact your hotel administrator");
});

it("keeps inconsistent older aggregate counts unavailable rather than presenting false totals", async () => {
  mocks.fetch.mockResolvedValueOnce(response({ ...saved, totalRows: 2, counts: { new: 1, changed: 2, unchanged: 0, blocked: 0 } }));
  expect((await getSupplierAiImport("hotel-a", "job")).counts).toBeNull();
});

it("retains the original upload command when an acknowledged payload has an invalid status or progress", async () => {
  for (const patch of [{ status: "unrecognized" }, { progress: { completedChunks: 3, totalChunks: 1 } }]) {
    sessionStorage.clear(); const selected = file(); acknowledgeUpload({ ...saved, ...patch });
    await expect(startSupplierAiImport("hotel-a", "supplier", selected, settings)).rejects.toThrow(/status|progress/);
    const original = mocks.fetch.mock.calls.at(-1)[0]; expect(Object.values(sessionStorage).join(" ")).toContain("requestId");
    acknowledgeUpload(saved); expect(await startSupplierAiImport("hotel-a", "supplier", new File(["SKU,Name\n001,Coffee"], "supplier.csv", { type: "text/csv" }), settings)).toEqual(saved);
    expect(mocks.fetch.mock.calls.at(-1)[0]).toBe(original); expect(Object.values(sessionStorage).join(" ")).not.toContain("requestId");
  }
});

it("requires an explicit complete price policy before uploading and snapshots gross VAT without changing the binary document", async () => {
  for (const invalid of [undefined, null, { ...settings, priceBasis: "" }, { ...settings, currency: "eur" }, { ...settings, currency: "ZZZ" }, { ...settings, vatRate: undefined }, { ...settings, vatRate: -0.01 }, { ...settings, vatRate: 1.01 }, { ...settings, vatRate: "6" }, { ...settings, extra: true }, { policyVersion: 2, priceBasis: "net", currency: "EUR" }]) await expect(startSupplierAiImport("hotel-a", "supplier", file(), invalid)).rejects.toThrow(/price basis/);
  expect(mocks.fetch).not.toHaveBeenCalled();
  const gross = { policyVersion: 2, priceBasis: "gross", currency: "EUR", vatRate: 0.06 }, document = file(); acknowledgeUpload({ ...saved, importSettings: gross });
  expect((await startSupplierAiImport("hotel-a", "supplier", document, gross)).importSettings).toEqual(gross);
  const [url, init] = postCalls()[0]; expect(JSON.parse(new URL(url).searchParams.get("importSettings"))).toEqual(gross); expect(init.body).toBe(document);
  expect(normalizeSupplierAiImportSettings({ ...settings, priceBasis: "unknown" })).toEqual({ ...settings, priceBasis: "unknown" });
});
it("holds the original upload settings after an unknown acknowledgement and rejects a changed policy before another request", async () => {
  const document = file(); loseUpload(new Error("Acknowledgement lost")); await expect(startSupplierAiImport("hotel-a", "supplier", document, settings)).rejects.toThrow("Acknowledgement lost");
  const originalUrl = postCalls()[0][0], changed = { ...settings, priceBasis: "gross", vatRate: 0.06 };
  await expect(startSupplierAiImport("hotel-a", "supplier", file(), changed)).rejects.toMatchObject({ code: "import-settings-changed", importSettings: settings }); expect(postCalls()).toHaveLength(1);
  expect(await startSupplierAiImport("hotel-a", "supplier", file(), settings)).toEqual(saved); expect(postCalls()[1][0]).toBe(originalUrl);
});
it("retains a v2 upload command when its acknowledgement changes or omits the immutable price settings", async () => {
  for (const returned of [null, { ...settings, currency: "USD" }, { ...settings, vatRate: 0 }]) {
    sessionStorage.clear(); acknowledgeUpload({ ...saved, importSettings: returned }); await expect(startSupplierAiImport("hotel-a", "supplier", file(), settings)).rejects.toThrow(/price settings/);
    const originalUrl = mocks.fetch.mock.calls.at(-1)[0]; acknowledgeUpload(saved); await startSupplierAiImport("hotel-a", "supplier", file(), settings); expect(mocks.fetch.mock.calls.at(-1)[0]).toBe(originalUrl);
  }
});
it("recovers an existing legacy request without applying new price selections or creating a new legacy command", async () => {
  const document = file(), bytes = new TextEncoder().encode("SKU,Name\n001,Coffee"), digest = Array.from(new Uint8Array(await webcrypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  sessionStorage.setItem(`supplier-ai-upload:manager:hotel-a:supplier:${digest}`, JSON.stringify({ requestId: "legacy-request", fileName: "original.csv", mimeType: "text/csv" }));
  mocks.fetch.mockResolvedValueOnce(response({ ...saved, importSettings: null, summary: null })); const result = await startSupplierAiImport("hotel-a", "supplier", document, { ...settings, priceBasis: "gross", vatRate: 0.06 });
  const url = new URL(mocks.fetch.mock.calls[0][0]); expect(url.searchParams.get("requestId")).toBe("legacy-request"); expect(url.searchParams.get("fileName")).toBe("original.csv"); expect(url.searchParams.has("importSettings")).toBe(false); expect(result.importSettings).toBeNull(); expect(result.summary).toBeNull();
});
it("uses only a validated hotel currency default and leaves older price snapshots unknown", async () => {
  for (const [currency, expected] of [["EUR", "EUR"], ["eur", null], ["ZZZ", null], [undefined, null]]) {
    mocks.fetch.mockResolvedValueOnce(response({ available: true, importPolicyVersion: 2, reason: null, defaults: { currency, vatRate: 0.21, providerCostUsd: 5 } })); expect((await getSupplierAiImportAvailability("hotel-a")).defaults).toEqual({ currency: expected });
  }
  mocks.fetch.mockResolvedValueOnce(response({ ...saved, importSettings: undefined, summary: undefined })); const legacy = await getSupplierAiImport("hotel-a", "job"); expect(legacy.importSettings).toBeNull(); expect(legacy.summary).toBeNull();
});

it("projects the full reconciled business summary without leaking operator fields and rejects partial or inconsistent summaries", async () => {
  const summary = { version: 2, totalRows: 210, normalizedRows: 200, assumptionRows: 150, unknownPriceRows: 210, blockedNormalizationRows: 2, inferredPieceRows: 30, missingRequiredRows: 15, findings: [{ field: "pricingModel", code: "missing-pricing-model", severity: "warning", message: "Choose a purchase pricing model; supplier purchase cost remains unavailable.", count: 15, rowIds: ["r-000001"], providerCostUsd: 1 }], model: "gpt-6-luna", usage: { costUsd: 1 } };
  mocks.fetch.mockResolvedValueOnce(response({ ...saved, status: "review", totalRows: 210, summary })); const result = await getSupplierAiImport("hotel-a", "job"); expect(result.summary.totalRows).toBe(210); expect(result.summary.unknownPriceRows).toBe(210); expect(result.summary.findings[0].message).toContain("purchase pricing model"); expect(JSON.stringify(result.summary)).not.toMatch(/gpt-6|providerCostUsd|costUsd|usage/);
  expect(normalizeSupplierAiImportSummary({ ...summary, missingRequiredRows: null }, 210)).toBeNull(); expect(normalizeSupplierAiImportSummary(summary, 25)).toBeNull();
  mocks.fetch.mockResolvedValueOnce(response({ ...saved, status: "processing", totalRows: 210, summary })); expect((await getSupplierAiImport("hotel-a", "job")).summary).toBeNull();
  mocks.fetch.mockResolvedValueOnce(response({ ...saved, status: "review", importSettings: null, totalRows: 210, summary })); const legacy = await getSupplierAiImport("hotel-a", "job"); expect(legacy.summary).toBeNull();
});

it("parses VAT percentages without binary division artifacts and rejects unsupported fraction precision before sending", async () => {
  for (const [input, expected] of [["5.6", 0.056], ["0.35", 0.0035], ["6.000000", 0.06], ["0.0001", 0.000001], ["0", 0], ["100", 1]]) { expect(supplierAiImportVatFraction(input)).toBe(expected); expect(normalizeSupplierAiImportSettings({ ...settings, priceBasis: "gross", vatRate: expected }).vatRate).toBe(expected); }
  for (const invalid of ["", "-1", "101", "5.60001", "0.00001", "1e-1"]) expect(() => supplierAiImportVatFraction(invalid)).toThrow();
  for (const vatRate of [0.055999999999999994, 0.0034999999999999996, 0.0000001]) await expect(startSupplierAiImport("hotel-a", "supplier", file(), { ...settings, priceBasis: "gross", vatRate })).rejects.toThrow(/price basis/); expect(mocks.fetch).not.toHaveBeenCalled();
});

it("blocks a new upload before command allocation when the deployed import service lacks policy v2", async () => {
  for (const value of [{ available: true }, { available: true, importPolicyVersion: 1 }]) {
    mocks.fetch.mockResolvedValueOnce(response(value)); expect(await getSupplierAiImportAvailability("hotel-a")).toMatchObject({ available: false, importPolicyVersion: null, reason: "upgrade-required" });
    mocks.fetch.mockResolvedValueOnce(response(value)); await expect(startSupplierAiImport("hotel-a", "supplier", file(), settings)).rejects.toMatchObject({ code: "failed-precondition", message: "Import service update is in progress. Try again after it finishes." });
    expect(postCalls()).toHaveLength(0); expect(sessionStorage.length).toBe(0);
  }
});
it("preserves an unknown v2 upload command through an older service revision until recovery is safe", async () => {
  loseUpload(new Error("Acknowledgement lost")); await expect(startSupplierAiImport("hotel-a", "supplier", file(), settings)).rejects.toThrow("Acknowledgement lost"); const originalUrl = postCalls()[0][0];
  const originalRecord = Object.values(sessionStorage).join(" "); mocks.fetch.mockResolvedValueOnce(response({ available: true, importPolicyVersion: 1 }));
  await expect(startSupplierAiImport("hotel-a", "supplier", file(), settings)).rejects.toMatchObject({ code: "unavailable" }); expect(postCalls()).toHaveLength(1); expect(Object.values(sessionStorage).join(" ")).toBe(originalRecord);
  acknowledgeUpload(saved); await startSupplierAiImport("hotel-a", "supplier", file(), settings); expect(postCalls()[1][0]).toBe(originalUrl);
});
it("checks a fresh service capability before starting instead of reusing an older in-flight availability read", async () => {
  const earlier = deferred(); mocks.fetch.mockReturnValueOnce(earlier.promise); const ongoing = getSupplierAiImportAvailability("hotel-a"); await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
  acknowledgeUpload(saved); expect(await startSupplierAiImport("hotel-a", "supplier", file(), settings)).toEqual(saved); expect(postCalls()).toHaveLength(1);
  earlier.resolve(response({ available: true, importPolicyVersion: 1 })); expect(await ongoing).toMatchObject({ available: false, reason: "upgrade-required" });
});
it("invalidates pre-correction status reads so the aggregate refresh cannot reuse an older snapshot", async () => {
  const earlier = deferred(); mocks.fetch.mockReturnValueOnce(earlier.promise); const obsolete = getSupplierAiImport("hotel-a", "job"); await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
  mocks.callable.mockResolvedValueOnce({ data: { hotelUid: "hotel-a", jobId: "job", row: { rowId: "r1", reviewRevision: 2 } } }); await saveSupplierAiImportReview("hotel-a", { jobId: "job", rowId: "r1", expectedReviewRevision: 1, patch: { pricePerPurchaseUnit: 12 } });
  const refreshed = getSupplierAiImport("hotel-a", "job"); await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2)); const rejected = expect(obsolete).rejects.toThrow(/access changed/); earlier.resolve(response(saved)); await rejected; expect(await refreshed).toEqual(saved);
});

it("does not overwrite another pending document's settings when concurrent capability checks finish later", async () => {
  const firstCapability = deferred(), secondCapability = deferred(); let check = 0;
  mocks.fetch.mockImplementation((_, input) => input.method === "GET" ? (check++ === 0 ? firstCapability.promise : secondCapability.promise) : Promise.reject(new Error("Acknowledgement lost")));
  const first = startSupplierAiImport("hotel-a", "supplier", file(), settings); await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
  const second = startSupplierAiImport("hotel-a", "supplier", file(), { ...settings, priceBasis: "gross", vatRate: 0.06 });
  await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2)); const unknown = expect(first).rejects.toThrow("Acknowledgement lost"); firstCapability.resolve(response(availability)); await unknown;
  const originalUrl = postCalls()[0][0], originalRecord = Object.values(sessionStorage).join(" "), changed = expect(second).rejects.toMatchObject({ code: "import-settings-changed", importSettings: settings }); secondCapability.resolve(response(availability)); await changed;
  expect(postCalls()).toHaveLength(1); expect(Object.values(sessionStorage).join(" ")).toBe(originalRecord);
  acknowledgeUpload(saved); await startSupplierAiImport("hotel-a", "supplier", file(), settings); expect(postCalls()[1][0]).toBe(originalUrl);
});
