import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), apply: vi.fn(), permission: vi.fn(() => true) }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: (...args) => mocks.permission(...args) }));
vi.mock("../../services/firebaseSupplierImportWorkspace", () => ({ readSupplierPurchaseUnitMappings: (...args) => mocks.read(...args), saveSupplierPurchaseUnitMappings: (...args) => mocks.save(...args), applySupplierImportMapping: (...args) => mocks.apply(...args) }));
import SupplierImportMappingsPanel from "./SupplierImportMappingsPanel";
const profile = { version: 1, supplierId: "supplier", sourceFormat: "xlsx", profileId: "default", revision: 0, mappings: [], suggestions: [] };
const group = { sourceUnit: "FL", count: 1, suggestedUnit: "Bottle", status: "unmapped", rowIds: [{ rowId: "r-000001", reviewRevision: 1 }] };
const props = () => ({ hotelUid: "hotel-a", jobId: "job", supplierId: "supplier", sourceFormat: "xlsx", groups: [group], current: () => true, onApplied: vi.fn(), onBusyChange: vi.fn() });
const applied = (rows) => ({ rows: rows.map((row) => ({ ...row, reviewRevision: row.reviewRevision + 1 })), outcomes: rows.map((row) => ({ rowId: row.rowId, status: "mapped", reviewRevision: row.reviewRevision + 1 })) });
beforeEach(() => { vi.clearAllMocks(); mocks.permission.mockReturnValue(true); mocks.read.mockResolvedValue(profile); mocks.save.mockResolvedValue({ ...profile, revision: 1, mappings: [{ sourceUnit: "FL", purchaseUnit: "Bottle" }] }); mocks.apply.mockImplementation(async (_, __, input) => applied(input.rows)); });
it("shows an empty standalone profile and requires an explicit save after choosing a suggestion", async () => {
  mocks.read.mockResolvedValueOnce({ ...profile, suggestions: [{ sourceUnit: "FL", purchaseUnit: "Bottle" }] });
  render(<SupplierImportMappingsPanel hotelUid="hotel-a" supplierId="supplier" sourceFormat="xlsx" standalone />);
  await screen.findByText("No saved mappings for this supplier and file format.");
  fireEvent.click(screen.getByRole("button", { name: "Use FL → Bottle" }));
  expect(screen.getByRole("textbox", { name: "Source package code" })).toHaveValue("FL");
  expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.apply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save mapping for future imports" }));
  await screen.findByText(/FL → Bottle saved for future XLSX imports/);
  expect(mocks.save).toHaveBeenCalledWith("hotel-a", "supplier", "xlsx", "default", 0, [{ sourceUnit: "FL", purchaseUnit: "Bottle" }]);
  expect(mocks.apply).not.toHaveBeenCalled();
  expect(screen.queryByText(/Apply the saved rule to this draft separately/)).not.toBeInTheDocument();
});
it("allows create-only users to recover their original new-rule save without granting replacement rights", async () => {
  mocks.permission.mockImplementation((_, action) => action !== "update");
  mocks.read.mockResolvedValueOnce({ ...profile, suggestions: [{ sourceUnit: "FL", purchaseUnit: "Bottle" }] });
  mocks.save.mockRejectedValueOnce(new Error("Connection lost"));
  render(<SupplierImportMappingsPanel hotelUid="hotel-a" supplierId="supplier" sourceFormat="xlsx" standalone />);
  fireEvent.click(await screen.findByRole("button", { name: "Use FL → Bottle" }));
  fireEvent.click(screen.getByRole("button", { name: "Save mapping for future imports" }));
  const retry = await screen.findByRole("button", { name: "Retry the same rule save" }); expect(retry).toBeEnabled();
  fireEvent.click(retry); await screen.findByText(/FL → Bottle saved for future XLSX imports/);
  expect(mocks.save.mock.calls[0]).toEqual(mocks.save.mock.calls[1]);
  expect(screen.getByRole("button", { name: "Edit FL rule" })).toBeDisabled();
});
it("recovers a standalone unknown save with the same code and revision and prevents replacement edits", async () => {
  mocks.read.mockResolvedValueOnce({ ...profile, suggestions: [{ sourceUnit: "FL", purchaseUnit: "Bottle" }] });
  mocks.save.mockRejectedValueOnce(new Error("Connection lost"));
  render(<SupplierImportMappingsPanel hotelUid="hotel-a" supplierId="supplier" sourceFormat="xlsx" standalone />);
  fireEvent.click(await screen.findByRole("button", { name: "Use FL → Bottle" }));
  fireEvent.click(screen.getByRole("button", { name: "Save mapping for future imports" }));
  await screen.findByRole("button", { name: "Retry the same rule save" });
  expect(screen.getByRole("textbox", { name: "Source package code" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save mapping for future imports" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Retry the same rule save" }));
  await screen.findByText(/FL → Bottle saved for future XLSX imports/);
  expect(mocks.save.mock.calls[0]).toEqual(mocks.save.mock.calls[1]); expect(mocks.apply).not.toHaveBeenCalled();
});
it("permits standalone read-only profiles but prevents add and edit without current create authority", async () => {
  mocks.permission.mockImplementation((_, action) => action !== "create");
  mocks.read.mockResolvedValueOnce({ ...profile, revision: 1, mappings: [{ sourceUnit: "FL", purchaseUnit: "Bottle" }] });
  render(<SupplierImportMappingsPanel hotelUid="hotel-a" supplierId="supplier" sourceFormat="xlsx" standalone />);
  await screen.findByText("Saved mappings (1)");
  expect(screen.getByRole("button", { name: "Edit FL rule" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save mapping for future imports" })).toBeDisabled();
  expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.apply).not.toHaveBeenCalled();
});
it("keeps a failed empty-profile read visible and can retry without creating a mapping", async () => {
  mocks.read.mockRejectedValueOnce(new Error("Profile connection lost"));
  render(<SupplierImportMappingsPanel hotelUid="hotel-a" supplierId="supplier" sourceFormat="xlsx" standalone />);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Retry mapping profile" }));
  await screen.findByText("No saved mappings for this supplier and file format.");
  expect(mocks.read).toHaveBeenCalledTimes(2); expect(mocks.save).not.toHaveBeenCalled();
});
it("requires explicit confirmation of supplier-code suggestions and does not save rules without the checkbox", async () => {
  const p = props(); render(<SupplierImportMappingsPanel {...p} />); await screen.findByRole("combobox", { name: "Purchase unit for FL" }); await waitFor(() => expect(mocks.read).toHaveBeenCalled()); expect(mocks.apply).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm & apply" })); await screen.findByText(/1 draft products updated/); expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.apply).toHaveBeenCalledWith("hotel-a", "job", { sourceUnit: "FL", purchaseUnit: "Bottle", expectedMappingRevision: null, rows: group.rowIds }); expect(p.onApplied).toHaveBeenCalledTimes(1);
});
it("saves a supplier/format rule first, then applies its confirmed revision without approving or importing products", async () => {
  render(<SupplierImportMappingsPanel {...props()} />); const remember = await screen.findByRole("checkbox", { name: /Save this mapping/ }); await waitFor(() => expect(remember).not.toBeDisabled()); fireEvent.click(remember); fireEvent.click(screen.getByRole("button", { name: "Confirm & apply" }));
  await screen.findByText(/supplier rule was saved/); expect(mocks.save).toHaveBeenCalledWith("hotel-a", "supplier", "xlsx", "default", 0, [{ sourceUnit: "FL", purchaseUnit: "Bottle" }]); expect(mocks.apply.mock.calls[0][2].expectedMappingRevision).toBe(1); expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(mocks.apply.mock.invocationCallOrder[0]);
});
it("uses bounded explicit batches and reports actual mapped, preserved and blocked results", async () => {
  const p = props(); p.groups = [{ ...group, count: 26, rowIds: Array.from({ length: 26 }, (_, index) => ({ rowId: `r-${String(index + 1).padStart(6, "0")}`, reviewRevision: 1 })) }]; mocks.apply.mockImplementationOnce(async (_, __, input) => applied(input.rows)).mockResolvedValueOnce({ rows: [], outcomes: [{ rowId: "r-000026", status: "skipped", reason: "human-correction" }] }); render(<SupplierImportMappingsPanel {...p} />); await screen.findByRole("combobox"); fireEvent.click(screen.getByRole("button", { name: "Confirm & apply" })); await screen.findByText(/25 draft products updated, 1 preserved, 0 need individual review/); expect(mocks.apply.mock.calls.map((call) => call[2].rows.length)).toEqual([25, 1]);
});
it("holds unknown acknowledgements and retries the same original selection without saving twice", async () => {
  render(<SupplierImportMappingsPanel {...props()} />); const remember = await screen.findByRole("checkbox", { name: /Save this mapping/ }); await waitFor(() => expect(remember).not.toBeDisabled()); fireEvent.click(remember); mocks.apply.mockRejectedValueOnce(new Error("Connection lost")); fireEvent.click(screen.getByRole("button", { name: "Confirm & apply" })); await screen.findByRole("button", { name: "Retry the same mapping" }); fireEvent.click(screen.getByRole("button", { name: "Retry the same mapping" })); await screen.findByText(/1 draft products updated/); expect(mocks.save).toHaveBeenCalledTimes(1); expect(mocks.apply.mock.calls[0]).toEqual(mocks.apply.mock.calls[1]);
});
it("refreshes a stale profile after a known aborted response instead of permanently replaying the old revision", async () => {
  const p = props(); mocks.apply.mockRejectedValueOnce(Object.assign(new Error("The supplier rule changed."), { code: "functions/aborted" })); mocks.read.mockResolvedValueOnce(profile).mockResolvedValueOnce({ ...profile, revision: 2, mappings: [{ sourceUnit: "FL", purchaseUnit: "Jar" }] }); render(<SupplierImportMappingsPanel {...p} />); const remember = await screen.findByRole("checkbox", { name: /Save this mapping/ }); await waitFor(() => expect(remember).not.toBeDisabled()); fireEvent.click(remember); fireEvent.click(screen.getByRole("button", { name: "Confirm & apply" })); await screen.findByText(/Current rule: FL → Jar/); expect(screen.queryByRole("button", { name: "Retry the same mapping" })).not.toBeInTheDocument(); expect(p.onApplied).toHaveBeenCalledTimes(1);
  mocks.save.mockResolvedValueOnce({ ...profile, revision: 3, mappings: [{ sourceUnit: "FL", purchaseUnit: "Bottle" }] }); fireEvent.click(screen.getByRole("button", { name: "Confirm & apply" })); await screen.findByText(/1 draft products updated/); expect(mocks.save.mock.calls[1][4]).toBe(2); expect(mocks.apply.mock.calls[1][2].expectedMappingRevision).toBe(3);
});
it("does not publish a late result or apply a rule when authority changes", async () => {
  let resolve, current = true; mocks.save.mockReturnValueOnce(new Promise((done) => { resolve = done; })); const p = props(); p.current = () => current; render(<SupplierImportMappingsPanel {...p} />); const remember = await screen.findByRole("checkbox", { name: /Save this mapping/ }); await waitFor(() => expect(remember).not.toBeDisabled()); fireEvent.click(remember); fireEvent.click(screen.getByRole("button", { name: "Confirm & apply" })); await waitFor(() => expect(resolve).toBeDefined()); current = false; await act(async () => resolve({ ...profile, revision: 1 })); expect(mocks.apply).not.toHaveBeenCalled(); expect(p.onApplied).not.toHaveBeenCalled();
});
const savedProfile = { ...profile, revision: 1, mappings: [{ sourceUnit: "FL", purchaseUnit: "Bottle" }] };
const openSaved = async () => { await screen.findByText("Saved mappings (1)"); fireEvent.click(screen.getByText("Saved mappings (1)")); };
const chooseSavedBox = () => { fireEvent.focus(screen.getByRole("combobox", { name: "Saved purchase unit for FL" })); fireEvent.click(screen.getByRole("option", { name: "Box", exact: true })); };
it("edits a saved rule for future imports without touching mapped draft products until a separate explicit application", async () => {
  const p = props(); p.groups = [{ ...group, status: "mapped", purchaseUnit: "Bottle" }]; mocks.read.mockResolvedValueOnce(savedProfile); mocks.save.mockResolvedValueOnce({ ...savedProfile, revision: 2, mappings: [{ sourceUnit: "FL", purchaseUnit: "Box" }] }); render(<SupplierImportMappingsPanel {...p} />); await openSaved(); fireEvent.click(screen.getByRole("button", { name: "Edit FL rule" })); chooseSavedBox(); fireEvent.click(screen.getByRole("button", { name: "Save for future imports" })); await screen.findByText(/FL → Box saved for future XLSX imports/); expect(mocks.save).toHaveBeenCalledWith("hotel-a", "supplier", "xlsx", "default", 1, [{ sourceUnit: "FL", purchaseUnit: "Box" }]); expect(mocks.apply).not.toHaveBeenCalled(); expect(p.onApplied).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Apply FL rule to this draft" })); await screen.findByText(/saved supplier rule was explicitly applied/); expect(mocks.apply).toHaveBeenCalledWith("hotel-a", "job", { sourceUnit: "FL", purchaseUnit: "Box", expectedMappingRevision: 2, rows: group.rowIds }); expect(p.onApplied).toHaveBeenCalledTimes(1);
});
it("requires update permission to replace a saved supplier rule", async () => {
  mocks.permission.mockImplementation((_, action) => action !== "update"); mocks.read.mockResolvedValueOnce(savedProfile); render(<SupplierImportMappingsPanel {...props()} />); await openSaved(); expect(screen.getByRole("button", { name: "Edit FL rule" })).toBeDisabled(); expect(screen.getByText(/update permission is required/)).toBeInTheDocument(); expect(mocks.save).not.toHaveBeenCalled();
});
it("retains an unknown saved-rule acknowledgement and retries the original expected revision and choice", async () => {
  mocks.read.mockResolvedValueOnce(savedProfile); mocks.save.mockRejectedValueOnce(new Error("Rule save connection lost")).mockResolvedValueOnce({ ...savedProfile, revision: 2, mappings: [{ sourceUnit: "FL", purchaseUnit: "Box" }] }); render(<SupplierImportMappingsPanel {...props()} />); await openSaved(); fireEvent.click(screen.getByRole("button", { name: "Edit FL rule" })); chooseSavedBox(); fireEvent.click(screen.getByRole("button", { name: "Save for future imports" })); await screen.findByRole("button", { name: "Retry the same rule save" }); expect(screen.getByRole("button", { name: "Save for future imports" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Confirm & apply" })).toBeDisabled(); fireEvent.click(screen.getByRole("button", { name: "Retry the same rule save" })); await screen.findByText(/FL → Box saved for future/); expect(mocks.save.mock.calls[0]).toEqual(mocks.save.mock.calls[1]); expect(mocks.apply).not.toHaveBeenCalled();
});
it("refreshes a concurrently changed saved rule after known aborted and lets the user confirm against the new profile", async () => {
  mocks.read.mockResolvedValueOnce(savedProfile).mockResolvedValueOnce({ ...savedProfile, revision: 4, mappings: [{ sourceUnit: "FL", purchaseUnit: "Jar" }] }); mocks.save.mockRejectedValueOnce(Object.assign(new Error("The supplier rule changed."), { code: "functions/aborted" })).mockResolvedValueOnce({ ...savedProfile, revision: 5, mappings: [{ sourceUnit: "FL", purchaseUnit: "Box" }] }); render(<SupplierImportMappingsPanel {...props()} />); await openSaved(); fireEvent.click(screen.getByRole("button", { name: "Edit FL rule" })); chooseSavedBox(); fireEvent.click(screen.getByRole("button", { name: "Save for future imports" })); await screen.findByText(/Revision 4/); expect(screen.queryByRole("button", { name: "Retry the same rule save" })).not.toBeInTheDocument(); expect(screen.getByRole("button", { name: "Save for future imports" })).not.toBeDisabled(); fireEvent.click(screen.getByRole("button", { name: "Save for future imports" })); await screen.findByText(/revision 5/); expect(mocks.save.mock.calls[1][4]).toBe(4); expect(mocks.apply).not.toHaveBeenCalled();
});
