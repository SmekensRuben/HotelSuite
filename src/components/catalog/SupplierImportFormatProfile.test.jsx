import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ save: vi.fn(), apply: vi.fn(), read: vi.fn() }));
vi.mock("../../services/firebaseSupplierImportWorkspace", () => ({ saveSupplierPurchaseUnitMappings: mocks.save, applySupplierImportFormat: mocks.apply, readSupplierPurchaseUnitMappings: mocks.read }));
import SupplierImportFormatProfile from "./SupplierImportFormatProfile";
const candidate = { version: 1, sourceFormat: "csv", header: ["SKU", "Name", "Package", "Content", "Price"], sheetName: null, columns: { supplierSku: 0, supplierProductName: 1, purchaseUnit: 2, baseUnitsPerPurchaseUnit: 3, pricePerPurchaseUnit: 4 }, defaults: { baseUnit: "kg", priceBasis: "net", currency: "EUR", sourceIssuedOn: "2025-01-01", priceValidFrom: "2025-01-01" }, decimalSeparator: ".", dateFormat: "YYYY-MM-DD", assortmentMode: "partial", documentPurpose: "price-list" };
const profile = { revision: 2, mappings: [], interpretation: null };
const props = () => ({ hotelUid: "hotel-a", jobId: "job-a", supplierId: "supplier", sourceFormat: "csv", profileId: "default", profile, candidate, interpretation: { status: "review-required" }, canCreate: true, canUpdate: true, locked: false, current: () => true, onSaved: vi.fn(), onApplied: vi.fn(), onBusyChange: vi.fn() });
const review = async () => { fireEvent.click(screen.getByRole("button", { name: "Review file format" })); fireEvent.click(screen.getByRole("checkbox", { name: /I checked the columns/ })); };
beforeEach(() => { vi.clearAllMocks(); mocks.save.mockImplementation(async (_, __, ___, ____, revision, _____, settings) => ({ ...profile, revision: revision + 1, interpretation: settings.interpretation })); mocks.apply.mockResolvedValue({}); });
it("requires explicit interpretation review and saves only reusable defaults without applying or approving prices", async () => {
  const properties = props(); render(<SupplierImportFormatProfile {...properties} />);
  expect(screen.getByText(/The file format changed/)).toBeInTheDocument(); fireEvent.click(screen.getByRole("button", { name: "Review file format" }));
  expect(screen.getByRole("button", { name: "Save reviewed file format" })).toBeDisabled(); expect(mocks.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox", { name: /I checked the columns/ }));
  fireEvent.change(screen.getByLabelText("Format column: Package barcode"), { target: { value: "2" } });
  expect(screen.getByRole("button", { name: "Save reviewed file format" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: /I checked the columns/ })); fireEvent.click(screen.getByRole("button", { name: "Save reviewed file format" }));
  await waitFor(() => expect(properties.onSaved).toHaveBeenCalled());
  expect(mocks.save.mock.calls[0].slice(0, 6)).toEqual(["hotel-a", "supplier", "csv", "default", 2, []]);
  expect(mocks.save.mock.calls[0][6].interpretation).toMatchObject({ columns: { supplierSku: 0, gtin: 2 }, defaults: { baseUnit: "kg", priceBasis: "net", currency: "EUR" } });
  expect(mocks.save.mock.calls[0][6].interpretation.defaults.sourceIssuedOn).toBeUndefined(); expect(mocks.apply).not.toHaveBeenCalled();
});
it("holds a lost save acknowledgement, locks interpretation edits and retries the original revision and mappings", async () => {
  mocks.save.mockRejectedValueOnce(new Error("Acknowledgement lost")); render(<SupplierImportFormatProfile {...props()} />); await review(); fireEvent.click(screen.getByRole("button", { name: "Save reviewed file format" }));
  const retry = await screen.findByRole("button", { name: "Retry the same format operation" });
  expect(screen.getByLabelText("Format column: Article number")).toBeDisabled(); fireEvent.click(retry);
  await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2)); expect(mocks.save.mock.calls[0]).toEqual(mocks.save.mock.calls[1]);
});
it("requires separate reprocessing against the saved profile revision and leaves source corrections to the backend", async () => {
  const properties = { ...props(), profile: { ...profile, interpretation: candidate }, candidate: null, interpretation: { status: "confirmed" } }; render(<SupplierImportFormatProfile {...properties} />);
  expect(mocks.apply).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Reprocess this draft with saved format" }));
  await waitFor(() => expect(properties.onApplied).toHaveBeenCalledTimes(1)); expect(mocks.apply).toHaveBeenCalledWith("hotel-a", "job-a", { expectedMappingRevision: 2 }); expect(mocks.save).not.toHaveBeenCalled();
});
it("blocks replacing confirmed formats without update permission and ignores late results after authority changes", async () => {
  const properties = { ...props(), profile: { ...profile, interpretation: candidate }, canUpdate: false }; const view = render(<SupplierImportFormatProfile {...properties} />);
  expect(screen.getByRole("button", { name: "Review file format" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Reprocess this draft with saved format" })).toBeEnabled(); expect(screen.getByText(/existing supplier offers also requires update permission/)).toBeInTheDocument();
  let resolve, active = true; mocks.save.mockReturnValueOnce(new Promise((done) => { resolve = done; })); view.rerender(<SupplierImportFormatProfile {...props()} current={() => active} onSaved={properties.onSaved} />);
  await review(); fireEvent.click(screen.getByRole("button", { name: "Save reviewed file format" })); await waitFor(() => expect(resolve).toBeDefined()); active = false;
  await act(async () => resolve({ ...profile, revision: 3, interpretation: candidate })); expect(properties.onSaved).not.toHaveBeenCalled();
});
it("resumes a reloaded partial format application using its original request and profile revision", async () => {
  const properties = { ...props(), profile: { ...profile, revision: 7, interpretation: candidate }, formatApplication: { requestId: "original-format-request", profileRevision: 2, processed: 25, totalRows: 40, complete: false } };
  render(<SupplierImportFormatProfile {...properties} />);
  expect(screen.getByText(/paused after 25 of 40 articles/)).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Review file format" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Resume original format application" }));
  await waitFor(() => expect(mocks.apply).toHaveBeenCalledWith("hotel-a", "job-a", { expectedMappingRevision: 2, requestId: "original-format-request" }));
  expect(properties.onApplied).toHaveBeenCalledTimes(1); expect(mocks.save).not.toHaveBeenCalled();
});
