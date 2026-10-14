import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ save: vi.fn(), permissions: [] }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: (feature, action) => mocks.permissions.includes(`${feature}.${action}`) }));
vi.mock("../../services/firebaseProducts", () => ({ getCatalogProducts: vi.fn(async () => ({ products: [] })) }));
vi.mock("../../services/firebaseSupplierAiImports", () => ({ saveSupplierAiImportReview: mocks.save }));
import SupplierAiImportRow from "./SupplierAiImportRow";
const product = { supplierSku: "001", supplierProductName: "Chocolate Mini Muffin", purchaseUnit: "Box", baseUnit: "kg", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: null, pricePerBaseUnit: null, currency: "EUR", priceBasis: "net", vatRate: null, pricingModel: "Per Purchase Unit", active: false, catalogProductId: null, purchaseOptions: [] };
const row = (patch = {}) => ({ rowId: "r-000001", category: "new", reviewRevision: 1, product: { ...product }, previousProduct: null, committed: null, issues: [], changes: [], sourceAnchors: [{ sourceId: "csv-row-2", quote: "MINI-MUFF CHOC 10g DS1kg", sourceExcerpt: '["001","MINI-MUFF CHOC 10g","DS1kg"]', anchor: "CSV row 2", verified: true }], originalInput: { supplierProductName: "MINI-MUFF CHOC 10g", purchaseUnit: "DS", baseUnit: "KG", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: null, pricePerBaseUnit: null }, normalizationFindings: [{ field: "supplierProductName", code: "approved-name-expansion", severity: "warning", message: "Review the approved abbreviation expansion.", before: "MINI-MUFF CHOC 10g", after: "Chocolate Mini Muffin", provenance: "approved-name-expansion" }, { field: "purchaseUnit", code: "purchase-label-normalized", severity: "info", message: "Purchase label was translated.", before: "DS", after: "Box", provenance: "source" }], packInference: { piecesPerPurchaseUnit: 100, pieceQuantity: 10, pieceUnit: "g", provenance: "source-name" }, ...patch });
const props = (value) => ({ hotelUid: "hotel-a", jobId: "job", row: value, selected: false, onSelect: vi.fn(), onCorrected: vi.fn() });
beforeEach(() => { vi.clearAllMocks(); mocks.permissions = ["supplierproducts.read", "supplierproducts.create", "supplierproducts.update"]; });
describe("normalized supplier import row", () => {
  it("discloses original names, package assumptions and inferred piece quantities without creating a piece offer", async () => {
    const properties = props(row()); mocks.save.mockResolvedValue({ row: row({ reviewRevision: 2 }) }); render(<SupplierAiImportRow {...properties} />);
    expect(screen.getByRole("region", { name: "Proposed transformations" })).toHaveTextContent("MINI-MUFF CHOC 10g"); expect(screen.getByRole("region", { name: "Proposed transformations" })).toHaveTextContent("Chocolate Mini Muffin");
    expect(screen.getByText("100 pieces × 10 g = 1 kg per Box.")).toBeInTheDocument(); expect(screen.getByText(/does not create a separately purchasable piece option/)).toBeInTheDocument(); expect(screen.getByRole("checkbox", { name: /disclosed assumptions/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Review details" })); expect(screen.getByText("MINI-MUFF CHOC 10g DS1kg")).toBeInTheDocument(); expect(screen.getByText('["001","MINI-MUFF CHOC 10g","DS1kg"]')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save correction" })); await waitFor(() => expect(mocks.save).toHaveBeenCalled());
    const patch = mocks.save.mock.calls[0][1].patch; expect(patch).toMatchObject({ baseUnit: "kg", baseUnitsPerPurchaseUnit: 1, purchaseUnit: "Box", purchaseOptions: [], pricePerPurchaseUnit: null }); expect(patch).not.toHaveProperty("packInference"); expect(patch).not.toHaveProperty("normalizationFindings"); expect(patch).not.toHaveProperty("originalInput");
  });
  it("labels commercial pricing plainly and groups an unchanged unknown price instead of repeating an empty transformation", () => {
    render(<SupplierAiImportRow {...props(row({ normalizationFindings: [{ field: "pricingModel", code: "pricing-model-defaulted", severity: "warning", before: null, after: "Per Purchase Unit", provenance: "inference", message: "Review the purchase pricing." }, { field: "price", code: "price-source-missing", severity: "warning", before: null, after: null, provenance: "source", message: "No price was supplied." }] }))} />);
    const transformations = screen.getByRole("region", { name: "Proposed transformations" }); expect(transformations).toHaveTextContent("Purchase pricing"); expect(transformations).not.toHaveTextContent("pricingModel"); expect(transformations).not.toHaveTextContent("Purchase price"); expect(screen.getByText("Price not supplied")).toBeInTheDocument();
  });
  it("keeps absent prices unknown, recognizes genuine zero and preserves an existing source-less price contract", () => {
    const view = render(<SupplierAiImportRow {...props(row())} />); expect(screen.getByText("Price not supplied")).toBeInTheDocument(); expect(screen.getByRole("checkbox", { name: /I reviewed/ })).toBeEnabled(); expect(screen.queryByText("0 EUR")).not.toBeInTheDocument();
    view.rerender(<SupplierAiImportRow {...props(row({ product: { ...product, pricePerPurchaseUnit: 0 } }))} />); expect(screen.queryByText("Price not supplied")).not.toBeInTheDocument();
    view.rerender(<SupplierAiImportRow {...props(row({ category: "unchanged", previousProduct: { ...product, pricePerPurchaseUnit: 12 }, product: { ...product, pricePerPurchaseUnit: 12 }, normalizationFindings: [{ field: "pricePerPurchaseUnit", code: "price-source-missing", severity: "warning", before: null, after: 12, message: "Existing contract retained.", provenance: "source" }] }))} />);
    expect(screen.getByText("No new price supplied")).toBeInTheDocument(); expect(screen.getByText("The existing price contract is preserved. This document does not establish a price update.")).toBeInTheDocument();
  });
  it("does not turn mass into count or round an unknown piece count", () => {
    const view = render(<SupplierAiImportRow {...props(row({ category: "blocked", product: { ...product, baseUnit: "each" }, issues: [{ field: "baseUnit", code: "incompatible-dimension", message: "Mass cannot be linked to a count ingredient.", severity: "error" }] }))} />);
    expect(screen.getByText(/cannot be reconciled with this offer's reviewed package content/)).toBeInTheDocument(); expect(screen.queryByText(/= 100 each/)).not.toBeInTheDocument(); expect(screen.getByRole("checkbox", { name: /I reviewed/ })).toBeDisabled();
    view.rerender(<SupplierAiImportRow {...props(row({ packInference: { piecesPerPurchaseUnit: 83.33333, pieceQuantity: 12, pieceUnit: "g", provenance: "source-name" } }))} />); expect(screen.queryByText(/83 pieces/)).not.toBeInTheDocument(); expect(screen.getByText(/cannot be reconciled/)).toBeInTheDocument();
  });
  it("does not present an old piece inference as valid after reviewed package quantity or unit changes", () => {
    const view = render(<SupplierAiImportRow {...props(row({ product: { ...product, baseUnitsPerPurchaseUnit: 2 } }))} />);
    expect(screen.queryByText("100 pieces × 10 g = 1 kg per Box.")).not.toBeInTheDocument(); expect(screen.getByText(/cannot be reconciled with this offer's reviewed package content/)).toBeInTheDocument();
    view.rerender(<SupplierAiImportRow {...props(row({ product: { ...product, baseUnit: "g", baseUnitsPerPurchaseUnit: 1000 } }))} />); expect(screen.getByText("100 pieces × 10 g = 1000 g per Box.")).toBeInTheDocument();
    view.rerender(<SupplierAiImportRow {...props(row({ product: { ...product, baseUnit: "g", baseUnitsPerPurchaseUnit: 2 } }))} />); expect(screen.queryByText(/= 1000 g per Box/)).not.toBeInTheDocument(); expect(screen.getByText(/cannot be reconciled/)).toBeInTheDocument();
  });
  it("uses exact decimal package arithmetic instead of rejecting a valid fractional piece size", () => {
    render(<SupplierAiImportRow {...props(row({ product: { ...product, baseUnitsPerPurchaseUnit: 0.3 }, packInference: { piecesPerPurchaseUnit: 3, pieceQuantity: 0.1, pieceUnit: "kg", provenance: "source-name" } }))} />);
    expect(screen.getByText("3 pieces × 0.1 kg = 0.3 kg per Box.")).toBeInTheDocument(); expect(screen.queryByText(/cannot be reconciled/)).not.toBeInTheDocument();
  });
  it("preserves fixed identities and requires gross VAT before a blocked row can be selected", async () => {
    render(<SupplierAiImportRow {...props(row({ category: "blocked", previousProduct: product, product: { ...product, priceBasis: "gross", vatRate: null }, issues: [{ field: "vatRate", code: "missing", severity: "error", message: "The gross price requires a VAT rate." }] }))} />);
    expect(screen.getByText("Resolve before importing")).toBeInTheDocument(); expect(screen.getByRole("checkbox", { name: /I reviewed/ })).toBeDisabled(); fireEvent.click(screen.getByRole("button", { name: "Review details" }));
    expect(screen.getByLabelText("Supplier SKU")).toBeDisabled(); expect(screen.getByLabelText("Content unit")).toBeDisabled(); expect(screen.getByLabelText("VAT rate (%)")).toHaveValue(null); await act(async () => {});
  });
  it("displays commercial VAT as percent while retaining the exact original fractional input", async () => {
    render(<SupplierAiImportRow {...props(row({ product: { ...product, priceBasis: "gross", vatRate: 0.06 }, originalInput: { ...row().originalInput, vatRate: 0.06 }, normalizationFindings: [{ field: "vatRate", code: "vat-import-setting", severity: "info", before: null, after: 0.06, provenance: "import-setting", message: "The import VAT setting was used." }] }))} />);
    expect(screen.getByRole("region", { name: "Proposed transformations" })).toHaveTextContent("6%"); fireEvent.click(screen.getByRole("button", { name: "Review details" }));
    expect(screen.getByText("VAT rate (source fraction)")).toBeInTheDocument(); expect(screen.getByLabelText("VAT rate (%)")).toHaveValue(6); await act(async () => {});
  });
  it("retains permanently blocked source evidence while a create-only user can edit required product data", async () => {
    mocks.permissions = ["supplierproducts.read", "supplierproducts.create"];
    render(<SupplierAiImportRow {...props(row({ category: "blocked", issues: [{ field: "sourceAnchors", code: "evidence-quote-absent", message: "The source quote could not be verified. Editing product fields cannot verify it.", severity: "error" }] }))} />);
    expect(screen.getByRole("checkbox", { name: /I reviewed/ })).toBeDisabled(); fireEvent.click(screen.getByRole("button", { name: "Review details" })); expect(screen.getByRole("button", { name: "Save correction" })).toBeEnabled(); expect(screen.getByText(/Editing product fields cannot verify it/)).toBeInTheDocument(); await act(async () => {});
  });
  it("does not display provider accounting from unrelated row properties or execute document markup", async () => {
    render(<SupplierAiImportRow {...props(row({ model: "expensive", usage: { actualCostUsd: 0.25 }, originalInput: { ...row().originalInput, model: "private", supplierProductName: '<img src=x onerror="alert(1)">' } }))} />);
    fireEvent.click(screen.getByRole("button", { name: "Review details" })); expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeInTheDocument(); const article = screen.getByRole("article", { name: "Import row r-000001" }); expect(article.querySelector("img")).toBeNull(); expect(article).not.toHaveTextContent("expensive"); expect(article).not.toHaveTextContent("actualCostUsd"); await act(async () => {});
  });
});
