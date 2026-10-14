import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: { currentUser: { uid: "manager" } }, call: vi.fn(), endpoint: vi.fn() }));
vi.mock("../firebaseConfig", () => ({ auth: mocks.auth, functions: {}, httpsCallable: (_, endpoint) => { mocks.endpoint(endpoint); return mocks.call; } }));
import { invalidateProcurementReads } from "./procurementReadPool";
import { readCatalogSyncWorkspace, getPendingCatalogSyncApply, applyCatalogSync, retryCatalogSyncApply, getPendingCatalogSyncRefinement, refineCatalogSyncSuggestions, retryCatalogSyncRefinement } from "./firebaseCatalogSync";
const row = () => ({ rowId: "r-000001", supplierProductId: "offer-1", expectedSupplierRevision: 3, reviewRevision: 1, supplierProduct: { supplierId: "supplier", supplierSku: "001", supplierProductName: "Milk", baseUnit: "l", baseUnitsPerPurchaseUnit: 12, purchaseUnit: "Box", purchaseOptions: [] }, status: "new", existingMatches: [], proposedNewProduct: { name: "Milk", baseUnit: "l", active: true, inventoryTracked: true }, groupKey: "group-1", warnings: [] });
const workspace = () => ({ hotelUid: "hotel-a", jobId: "job-a", revision: 1, status: "review", supplierId: null, nextCursor: "offer-25", scannedSuppliers: 25, catalogPool: { count: 500, complete: false, limit: 500 }, rows: [row()] });
const choice = () => ({ rowId: "r-000001", reviewRevision: 1, expectedSupplierRevision: 3, acknowledged: true, target: { kind: "existing", catalogProductId: "catalog-1", expectedCatalogRevision: 4 } });
const success = (input) => ({ data: { hotelUid: input.hotelUid, jobId: input.jobId, requestId: input.requestId, outcomes: input.choices.map((selected) => ({ rowId: selected.rowId, supplierProductId: "offer-1", catalogProductId: "catalog-1", supplierRevision: 4, status: "linked" })), createdCatalogs: [], completed: true } });
beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); invalidateProcurementReads(); mocks.auth.currentUser = { uid: "manager" }; });
it("preserves preview identity across a lost response and subsequent reads use only the owned frozen job", async () => {
  mocks.call.mockRejectedValueOnce(new Error("Offline")).mockResolvedValue({ data: workspace() });
  await expect(readCatalogSyncWorkspace("hotel-a")).rejects.toThrow("Offline"); await readCatalogSyncWorkspace("hotel-a");
  expect(mocks.call.mock.calls[0][0]).toEqual(mocks.call.mock.calls[1][0]); await readCatalogSyncWorkspace("hotel-a");
  expect(mocks.call.mock.calls[2][0]).toEqual({ hotelUid: "hotel-a", jobId: "job-a" }); expect(mocks.endpoint).toHaveBeenCalledWith("readHotelCatalogSyncWorkspace");
});
it("freezes selected choices and retries the exact request without permitting changed targets", async () => {
  mocks.call.mockRejectedValueOnce(new Error("Acknowledgement lost")).mockImplementation(success);
  await expect(applyCatalogSync("hotel-a", "job-a", [choice()])).rejects.toThrow("Acknowledgement lost");
  expect(getPendingCatalogSyncApply("hotel-a", "job-a").input.choices).toEqual([choice()]);
  await expect(applyCatalogSync("hotel-a", "job-a", [{ ...choice(), target: { ...choice().target, catalogProductId: "different" } }])).rejects.toThrow("previous apply result is uncertain");
  const result = await retryCatalogSyncApply("hotel-a", "job-a"); expect(result.outcomes[0].status).toBe("linked"); expect(mocks.call.mock.calls[0][0]).toEqual(mocks.call.mock.calls[1][0]); expect(getPendingCatalogSyncApply("hotel-a", "job-a")).toBeNull();
});
it("releases a failed request only after the server establishes that no choices were committed", async () => {
  mocks.call.mockRejectedValueOnce(Object.assign(new Error("Source changed"), { code: "functions/aborted", details: { catalogSyncRequestUncommitted: true } })).mockImplementation(success);
  await expect(applyCatalogSync("hotel-a", "job-a", [choice()])).rejects.toThrow("Source changed"); expect(getPendingCatalogSyncApply("hotel-a", "job-a")).toBeNull();
  await applyCatalogSync("hotel-a", "job-a", [{ ...choice(), expectedSupplierRevision: 4 }]); expect(mocks.call.mock.calls[0][0].requestId).not.toBe(mocks.call.mock.calls[1][0].requestId);
});
it("does not infer non-commit from a permission code without receipt proof", async () => {
  mocks.call.mockRejectedValue(Object.assign(new Error("Access revoked"), { code: "functions/permission-denied" }));
  await expect(applyCatalogSync("hotel-a", "job-a", [choice()])).rejects.toThrow("Access revoked"); expect(getPendingCatalogSyncApply("hotel-a", "job-a")).not.toBeNull();
});
it("holds malformed or cross-hotel acknowledgements as uncertain and keeps the original operation", async () => {
  mocks.call.mockImplementation(async (input) => { const result = success(input); result.data.hotelUid = "hotel-b"; return result; });
  await expect(applyCatalogSync("hotel-a", "job-a", [choice()])).rejects.toThrow("another hotel"); expect(getPendingCatalogSyncApply("hotel-a", "job-a")).not.toBeNull();
});
it("drops a delayed mutation response after a same-UID Auth object or hotel authority changes", async () => {
  let resolve; mocks.call.mockReturnValueOnce(new Promise((done) => { resolve = done; })); const promise = applyCatalogSync("hotel-a", "job-a", [choice()]);
  const input = mocks.call.mock.calls[0][0]; mocks.auth.currentUser = { uid: "manager" }; resolve(success(input)); await expect(promise).rejects.toThrow("Hotel access changed");
  expect(getPendingCatalogSyncApply("hotel-a", "job-a")).not.toBeNull();
});
it("keeps actor and hotel operation identities separate", async () => {
  mocks.call.mockRejectedValue(new Error("Offline")); await expect(applyCatalogSync("hotel-a", "job-a", [choice()])).rejects.toThrow(); await expect(applyCatalogSync("hotel-b", "job-a", [choice()])).rejects.toThrow(); mocks.auth.currentUser = { uid: "another" }; await expect(applyCatalogSync("hotel-a", "job-a", [choice()])).rejects.toThrow(); expect(new Set(mocks.call.mock.calls.map(([input]) => input.requestId)).size).toBe(3);
});
it("validates unit/name, revision and explicit human acknowledgement before calling the backend", async () => {
  await expect(applyCatalogSync("hotel-a", "job-a", [{ ...choice(), acknowledged: false }])).rejects.toThrow("explicit exchangeability"); await expect(applyCatalogSync("hotel-a", "job-a", [{ ...choice(), target: { kind: "new", createGroupId: "same-group", product: { name: "Milk", baseUnit: "bottle" } } }])).rejects.toThrow("supported physical unit"); expect(mocks.call).not.toHaveBeenCalled();
});
it("preserves one reviewed definition and group identity for equivalent offers", async () => {
  mocks.call.mockImplementation(async (input) => ({ data: { ...success(input).data, outcomes: input.choices.map((item, index) => ({ rowId: item.rowId, supplierProductId: `offer-${index}`, catalogProductId: "one-new-catalog", supplierRevision: 4, status: "created-and-linked" })), createdCatalogs: [{ catalogProductId: "one-new-catalog", revision: 1 }], completed: true } }));
  const target = { kind: "new", createGroupId: "reviewed-milk-group", product: { name: "Reviewed milk", baseUnit: "l", inventoryTracked: true, active: true, brand: "", category: "", allergens: [] } };
  const result = await applyCatalogSync("hotel-a", "job-a", [{ ...choice(), target }, { ...choice(), rowId: "r-000002", target }]); expect(result.createdCatalogs).toHaveLength(1); expect(mocks.call.mock.calls[0][0].choices[0].target).toEqual(mocks.call.mock.calls[0][0].choices[1].target);
});
it("persists the original refinement request during unknown processing and forbids a new generation", async () => {
  mocks.call.mockImplementationOnce(async (input) => ({ data: { hotelUid: input.hotelUid, jobId: input.jobId, requestId: input.requestId, policyVersion: 1, status: "response-unknown", revision: 1, suggestions: [] } })).mockImplementation(async (input) => ({ data: { hotelUid: input.hotelUid, jobId: input.jobId, requestId: input.requestId, policyVersion: 1, status: "ready", revision: 2, suggestions: [{ rowId: "r-000001", catalogProductId: "catalog-1", reason: "Check this physical article.", specificDifferences: ["Brand must be reviewed."] }] } }));
  expect((await refineCatalogSyncSuggestions("hotel-a", "job-a", 1, ["r-000001"])).status).toBe("response-unknown"); expect(getPendingCatalogSyncRefinement("hotel-a", "job-a")).not.toBeNull(); await expect(refineCatalogSyncSuggestions("hotel-a", "job-a", 2, ["r-000002"])).rejects.toThrow("original suggestion request");
  const result = await retryCatalogSyncRefinement("hotel-a", "job-a"); expect(result.status).toBe("ready"); expect(mocks.call.mock.calls[0][0]).toEqual(mocks.call.mock.calls[1][0]); expect(getPendingCatalogSyncRefinement("hotel-a", "job-a")).toBeNull();
});
it("an unavailable optional suggestion leaves manual operations enabled and saves no model generation", async () => {
  mocks.call.mockImplementation(async (input) => ({ data: { hotelUid: input.hotelUid, jobId: input.jobId, requestId: input.requestId, policyVersion: 1, status: "disabled", revision: 1, suggestions: [], message: "Optional suggestions are disabled." } }));
  expect((await refineCatalogSyncSuggestions("hotel-a", "job-a", 1, ["r-000001"])).status).toBe("disabled"); expect(getPendingCatalogSyncRefinement("hotel-a", "job-a")).toBeNull();
});
it("rejects duplicate row choices and overlarge applies without invoking a mutation", async () => { await expect(applyCatalogSync("hotel-a", "job-a", [choice(), choice()])).rejects.toThrow("only once"); await expect(applyCatalogSync("hotel-a", "job-a", Array.from({ length: 26 }, (_, index) => ({ ...choice(), rowId: `row-${index}` })))).rejects.toThrow("between 1 and 25"); expect(mocks.call).not.toHaveBeenCalled(); });
it("accepts verified applied row facts and safely projects parsed each-item evidence", async () => {
  const value = workspace(); value.rows[0].applied = { catalogProductId: "catalog-1", supplierRevision: 4, status: "linked" }; value.rows[0].existingMatches = [{ catalogProductId: "catalog-1", expectedCatalogRevision: 4, product: { name: "Milk", baseUnit: "each", active: true, physicalIdentity: { dimension: "count", eachSpec: { unit: "l", quantity: 0.5, dimension: "volume" }, qualifiers: {} } }, reasons: ["The sizes agree."], warnings: [], evidence: { sourceEachSpec: { unit: "l", quantity: 0.5, dimension: "volume" }, catalogEachSpec: { unit: "l", quantity: 0.5, dimension: "volume" }, privateInternals: "secret" } }]; mocks.call.mockResolvedValue({ data: value });
  const result = await readCatalogSyncWorkspace("hotel-a"); expect(result.rows[0].applied.supplierRevision).toBe(4); expect(result.rows[0].existingMatches[0].evidence.sourceEachSpec.quantity).toBe(0.5); expect(result.rows[0].existingMatches[0].evidence.privateInternals).toBeUndefined();
});
it("unlocks stale AI inputs only with explicit no-reservation proof and otherwise retains the exact generation", async () => {
  mocks.call.mockRejectedValueOnce(Object.assign(new Error("Review revision changed"), { code: "functions/aborted", details: { catalogSyncRefinementUncommitted: true } })).mockRejectedValueOnce(Object.assign(new Error("Permission changed"), { code: "functions/permission-denied" }));
  await expect(refineCatalogSyncSuggestions("hotel-a", "job-a", 1, ["r-000001"])).rejects.toThrow("Review revision changed"); expect(getPendingCatalogSyncRefinement("hotel-a", "job-a")).toBeNull();
  await expect(refineCatalogSyncSuggestions("hotel-a", "job-a", 2, ["r-000001"])).rejects.toThrow("Permission changed"); expect(getPendingCatalogSyncRefinement("hotel-a", "job-a").input.expectedRevision).toBe(2); expect(mocks.call.mock.calls[0][0].requestId).not.toBe(mocks.call.mock.calls[1][0].requestId);
});
it("preserves an older unknown AI request while starting a fresh manual workspace", async () => {
  mocks.call.mockResolvedValueOnce({ data: workspace() }).mockImplementationOnce(async (input) => ({ data: { hotelUid: input.hotelUid, jobId: input.jobId, requestId: input.requestId, policyVersion: 1, status: "response-unknown", revision: 1, suggestions: [] } })).mockResolvedValueOnce({ data: { ...workspace(), jobId: "job-fresh" } }).mockImplementationOnce(async (input) => ({ data: { hotelUid: input.hotelUid, jobId: input.jobId, requestId: input.requestId, policyVersion: 1, status: "processing", revision: 1, suggestions: [] } }));
  await readCatalogSyncWorkspace("hotel-a"); await refineCatalogSyncSuggestions("hotel-a", "job-a", 1, ["r-000001"]); const original = mocks.call.mock.calls[1][0];
  expect((await readCatalogSyncWorkspace("hotel-a", { fresh: true })).jobId).toBe("job-fresh"); expect(getPendingCatalogSyncRefinement("hotel-a", "job-a")).not.toBeNull(); await retryCatalogSyncRefinement("hotel-a", "job-a"); expect(mocks.call.mock.calls[3][0]).toEqual(original);
});
