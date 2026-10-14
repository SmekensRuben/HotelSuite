import { applySupplierImportFormat } from "./firebaseSupplierImportWorkspace";
import { webcrypto } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: { currentUser: null }, callable: vi.fn() }));
vi.mock("../firebaseConfig", () => ({ auth: mocks.auth, functions: {}, httpsCallable: (_, name) => (input) => mocks.callable(name, input) }));
import { readSupplierImportWorkspace, decideSupplierImportRows, applySupplierImportMapping, readSupplierPurchaseUnitMappings, saveSupplierPurchaseUnitMappings, completeSupplierImportReview } from "./firebaseSupplierImportWorkspace";
import { invalidateProcurementReads } from "./procurementReadPool";
const row = (revision = 1, status = "pending") => ({ rowId: "r-000001", reviewRevision: revision, category: "new", product: { supplierProductName: "Butter", purchaseUnit: "Box", active: false }, issues: [], canApprove: true, bulkEligible: false, review: { status, reviewRevision: revision } });
const workspace = { hotelUid: "hotel-a", jobId: "job", supplierId: "supplier", importReviewVersion: 1, status: "review", totalRows: 1, rows: [row()], index: [{ rowId: "r-000001", reviewRevision: 1, category: "new", name: "Butter", sku: "001", reviewStatus: "pending", needsAttention: true, bulkEligible: false }], counts: { new: 1, changed: 0, unchanged: 0, blocked: 0 }, reviewCounts: { pending: 1, approved: 0, skipped: 0, applied: 0, failed: 0 }, sourceFormat: "xlsx", profileId: "default", nextCursor: null };
const profile = { hotelUid: "hotel-a", version: 1, supplierId: "supplier", sourceFormat: "xlsx", profileId: "default", revision: 0, mappings: [], suggestions: [{ sourceUnit: "FL", purchaseUnit: "Bottle", needsConfirmation: true }] };
beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); invalidateProcurementReads(); mocks.auth.currentUser = { uid: "manager" }; vi.stubGlobal("crypto", webcrypto); });
it("reads only the selected hotel workspace through a protected endpoint and supports direct product focus", async () => {
  mocks.callable.mockResolvedValue({ data: workspace }); expect((await readSupplierImportWorkspace("hotel-a", "job", { focusRowId: "r-000001" })).totalRows).toBe(1);
  expect(mocks.callable).toHaveBeenCalledWith("readHotelSupplierAiImportWorkspace", { hotelUid: "hotel-a", jobId: "job", cursor: null, filter: "all", includeIndex: true, limit: 25, focusRowId: "r-000001" });
});
it("rejects cross-hotel, cross-job and late same-UID actor replacement responses", async () => {
  for (const patch of [{ hotelUid: "hotel-b" }, { jobId: "other" }]) { mocks.callable.mockResolvedValueOnce({ data: { ...workspace, ...patch } }); await expect(readSupplierImportWorkspace("hotel-a", "job")).rejects.toThrow(/another hotel/); }
  let finish; mocks.callable.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; })); const request = readSupplierImportWorkspace("hotel-a", "job"); await vi.waitFor(() => expect(finish).toBeDefined()); mocks.auth.currentUser = { uid: "manager" }; finish({ data: workspace }); await expect(request).rejects.toThrow(/access changed/);
});
it("retains the same decision command after a lost acknowledgement and stores only opaque references", async () => {
  const rows = [{ rowId: "r-000001", reviewRevision: 1, action: "approve", acknowledged: true }]; mocks.callable.mockRejectedValueOnce(new Error("Connection lost")); await expect(decideSupplierImportRows("hotel-a", "job", rows)).rejects.toThrow("Connection lost");
  const original = mocks.callable.mock.calls[0][1].requestId; expect(Object.values(sessionStorage).join(" ")).not.toMatch(/Butter|supplierProductName|approve|r-000001/);
  mocks.callable.mockResolvedValueOnce({ data: { hotelUid: "hotel-a", jobId: "job", rows: [row(1, "approved")] } }); await decideSupplierImportRows("hotel-a", "job", rows); expect(mocks.callable.mock.calls[1][1].requestId).toBe(original); expect(sessionStorage.length).toBe(0);
});
it("keeps an incomplete decision acknowledgement recoverable and rejects changed product revisions", async () => {
  const rows = [{ rowId: "r-000001", reviewRevision: 1, action: "skip", acknowledged: true }]; mocks.callable.mockResolvedValueOnce({ data: { hotelUid: "hotel-a", jobId: "job", rows: [] } }); await expect(decideSupplierImportRows("hotel-a", "job", rows)).rejects.toThrow(/incomplete/);
  mocks.callable.mockResolvedValueOnce({ data: { hotelUid: "hotel-a", jobId: "job", rows: [row(2, "skipped")] } }); await expect(decideSupplierImportRows("hotel-a", "job", rows)).rejects.toThrow(/acknowledgement/); expect(mocks.callable.mock.calls[0][1].requestId).toBe(mocks.callable.mock.calls[1][1].requestId);
});
it("requires explicit acknowledgement and bounded decisions before making any request", async () => {
  await expect(decideSupplierImportRows("hotel-a", "job", [{ rowId: "r-000001", reviewRevision: 1, action: "approve", acknowledged: false }])).rejects.toThrow(/explicitly/); await expect(readSupplierImportWorkspace("hotel-a", "job", { limit: 1000 })).rejects.toThrow(/invalid/); expect(mocks.callable).not.toHaveBeenCalled();
});
it("keeps supplier mappings scoped by supplier and file format and drops all operator configuration", async () => {
  mocks.callable.mockResolvedValueOnce({ data: { ...profile, model: "gpt-private", costUsd: 4 } }); const result = await readSupplierPurchaseUnitMappings("hotel-a", "supplier", "xlsx"); expect(result.suggestions[0]).toEqual({ sourceUnit: "FL", purchaseUnit: "Bottle", needsConfirmation: true }); expect(JSON.stringify(result)).not.toMatch(/costUsd|gpt-private/);
  mocks.callable.mockResolvedValueOnce({ data: { ...profile, sourceFormat: "pdf" } }); await expect(readSupplierPurchaseUnitMappings("hotel-a", "supplier", "xlsx")).rejects.toThrow(/profile/);
});
it("saves the supplier mapping explicitly without modifying any draft product", async () => {
  mocks.callable.mockImplementationOnce(async (_, input) => ({ data: { ...profile, requestId: input.requestId, revision: 1, mappings: [{ sourceUnit: "TR", purchaseUnit: "Tray" }] } })); await saveSupplierPurchaseUnitMappings("hotel-a", "supplier", "xlsx", "default", 0, [{ sourceUnit: "TR", purchaseUnit: "Tray" }]); expect(mocks.callable.mock.calls[0][0]).toBe("saveHotelSupplierPurchaseUnitMapping"); expect(mocks.callable).toHaveBeenCalledTimes(1); expect(mocks.callable.mock.calls[0][1]).toMatchObject({ hotelUid: "hotel-a", supplierId: "supplier", sourceFormat: "xlsx", profileId: "default", expectedRevision: 0 });
});
it("applies only explicit current draft references and validates returned new revisions", async () => {
  const input = { sourceUnit: "DS", purchaseUnit: "Box", expectedMappingRevision: 1, rows: [{ rowId: "r-000001", reviewRevision: 1 }] }; mocks.callable.mockResolvedValueOnce({ data: { hotelUid: "hotel-a", jobId: "job", sourceUnit: "DS", purchaseUnit: "Box", rows: [row(2)], outcomes: [{ rowId: "r-000001", status: "mapped", reviewRevision: 2 }] } }); expect((await applySupplierImportMapping("hotel-a", "job", input)).rows[0].reviewRevision).toBe(2); expect(mocks.callable.mock.calls[0][1]).toMatchObject(input);
  mocks.callable.mockResolvedValueOnce({ data: { hotelUid: "hotel-a", jobId: "job", sourceUnit: "DS", purchaseUnit: "Box", rows: [row(1)], outcomes: [{ rowId: "r-000001", status: "mapped", reviewRevision: 1 }] } }); await expect(applySupplierImportMapping("hotel-a", "job", input)).rejects.toThrow(/revisions/);
});
it("resolves a mapping acknowledgement with preserved manual corrections and blocked rows without inventing updated products", async () => {
  const input = { sourceUnit: "DS", purchaseUnit: "Box", rows: [{ rowId: "r-000001", reviewRevision: 1 }, { rowId: "r-000002", reviewRevision: 1 }, { rowId: "r-000003", reviewRevision: 1 }] };
  mocks.callable.mockResolvedValueOnce({ data: { hotelUid: "hotel-a", jobId: "job", sourceUnit: "DS", purchaseUnit: "Box", rows: [row(2)], outcomes: [{ rowId: "r-000001", status: "mapped", reviewRevision: 2 }, { rowId: "r-000002", status: "skipped", reason: "human-correction" }, { rowId: "r-000003", status: "blocked", error: { code: "aborted", message: "This product changed." } }] } });
  const result = await applySupplierImportMapping("hotel-a", "job", input); expect(result.rows).toHaveLength(1); expect(result.outcomes.map((outcome) => outcome.status)).toEqual(["mapped", "skipped", "blocked"]); expect(sessionStorage.length).toBe(0);
});
it("retains an unverified saved mapping acknowledgement rather than claiming an unchanged or different supplier rule was saved", async () => {
  mocks.callable.mockImplementationOnce(async (_, input) => ({ data: { ...profile, requestId: input.requestId, revision: 1, mappings: [{ sourceUnit: "FL", purchaseUnit: "Jar" }] } })); await expect(saveSupplierPurchaseUnitMappings("hotel-a", "supplier", "xlsx", "default", 0, [{ sourceUnit: "FL", purchaseUnit: "Bottle" }])).rejects.toThrow(/saved supplier rule/); expect(sessionStorage.length).toBe(1);
});
it("does not expose provider billing errors and finalizes only through the protected completion endpoint", async () => {
  mocks.callable.mockRejectedValueOnce(new Error("OpenAI token budget USD 0.25 exceeded")); await expect(readSupplierImportWorkspace("hotel-a", "job")).rejects.toThrow(/administrator/);
  mocks.callable.mockResolvedValueOnce({ data: { hotelUid: "hotel-a", jobId: "job", totalRows: 1, reviewCounts: workspace.reviewCounts, completed: false } }); expect(await completeSupplierImportReview("hotel-a", "job")).toMatchObject({ completed: false }); expect(mocks.callable.mock.calls.at(-1)[0]).toBe("completeHotelSupplierAiImportReview");
});
it("does not announce a completed import or forget its original command when the complete counts still contain pending products", async () => {
  mocks.callable.mockResolvedValueOnce({ data: { hotelUid: "hotel-a", jobId: "job", totalRows: 1, reviewCounts: workspace.reviewCounts, completed: true } }); await expect(completeSupplierImportReview("hotel-a", "job")).rejects.toThrow(/final import status/); const original = mocks.callable.mock.calls[0][1].requestId;
  mocks.callable.mockResolvedValueOnce({ data: { hotelUid: "hotel-a", jobId: "job", totalRows: 1, reviewCounts: { pending: 0, approved: 0, skipped: 1, applied: 0, failed: 0 }, completed: true } }); expect(await completeSupplierImportReview("hotel-a", "job")).toMatchObject({ completed: true }); expect(mocks.callable.mock.calls[1][1].requestId).toBe(original); expect(sessionStorage.length).toBe(0);
});

it("resumes a partially applied format with the original server receipt after remount", async () => {
  mocks.callable.mockResolvedValueOnce({ data: { hotelUid: "hotel-a", jobId: "job", completed: true, rebuiltRows: 26, skippedRows: 0 } });
  const result = await applySupplierImportFormat("hotel-a", "job", { expectedMappingRevision: 2, requestId: "original-format-request" });
  expect(result.completed).toBe(true);
  expect(mocks.callable).toHaveBeenCalledWith("applyHotelSupplierImportFormat", { hotelUid: "hotel-a", jobId: "job", expectedMappingRevision: 2, requestId: "original-format-request" });
});
it("saves a reviewed column interpretation without requiring purchase-unit mappings", async () => {
  const interpretation = { version: 1, header: ["Article", "Unit price"], sheetName: null, columns: { supplierSku: 0, pricePerPurchaseUnit: 1 }, defaults: { pricingModel: "Per Purchase Unit", currency: "EUR" }, assortmentMode: "partial", documentPurpose: "price-list", decimalSeparator: ".", dateFormat: "YYYY-MM-DD" };
  mocks.callable.mockImplementationOnce(async (_name, input) => ({ data: { hotelUid: "hotel-a", supplierId: "supplier", sourceFormat: "csv", profileId: "default", version: 1, revision: 1, mappings: [], suggestions: [], interpretation: input.interpretation, requestId: input.requestId } }));
  const result = await saveSupplierPurchaseUnitMappings("hotel-a", "supplier", "csv", "default", 0, [], { interpretation });
  expect(result.interpretation.columns.supplierSku).toBe(0);
  expect(mocks.callable.mock.calls[0][1].mappings).toEqual([]);
  expect(mocks.callable.mock.calls[0][1].interpretation.documentPurpose).toBe("price-list");
});
