import React, { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ save: vi.fn(), catalog: vi.fn(), permissions: [] }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: (feature, action) => mocks.permissions.includes(`${feature}.${action}`) }));
vi.mock("../../services/firebaseProducts", () => ({ getCatalogProducts: mocks.catalog }));
vi.mock("../../services/firebaseSupplierAiImports", async () => {
  const actual = await vi.importActual("../../services/firebaseSupplierAiImports");
  return { ...actual, saveSupplierAiImportReview: mocks.save };
});
import SupplierImportProductReview from "./SupplierImportProductReview";
const product = { supplierSku: "001", supplierProductName: "Rochefort Boter 10g", purchaseUnit: "Box", baseUnit: "kg", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 8, pricePerBaseUnit: null, currency: "EUR", priceBasis: "net", vatRate: 0.06, pricingModel: "Per Purchase Unit", active: false, catalogProductId: null, purchaseOptions: [] };
const row = (patch = {}) => ({ rowId: "r-000001", category: "new", reviewRevision: 1, product: { ...product }, previousProduct: null, committed: false, canApprove: true, issues: [], changes: [], normalizationFindings: [], sourceAnchors: [{ sourceId: "csv-row-2", quote: "ROCH. BOTER 10G", sourceExcerpt: '001,ROCH. BOTER 10G,DS,1,KG,8.00', anchor: "CSV row 2", verified: true }], ...patch });
const props = (value = row()) => ({ hotelUid: "hotel-a", jobId: "job-a", row: value, position: 1, total: 40, current: () => true, onCorrected: vi.fn(), onApprove: vi.fn(), onSkip: vi.fn(), onLater: vi.fn() });
beforeEach(() => { vi.clearAllMocks(); mocks.permissions = ["supplierproducts.read", "supplierproducts.create", "supplierproducts.update"]; mocks.catalog.mockResolvedValue({ products: [] }); });

describe("compact supplier product review", () => {
  it("shows old and new brands and saves a separate brand correction before approval", async () => {
    const properties = props(row({ category: "changed", product: { ...product, brand: "Arla" },
      previousProduct: { ...product, brand: "Campina" }, changes: [{ field: "brand", before: "Campina", after: "Arla" }] }));
    mocks.save.mockResolvedValue({ row: row({ reviewRevision: 2, product: { ...product, brand: "Local Dairy" } }) });
    render(<SupplierImportProductReview {...properties} />);
    expect(screen.getByText("Campina")).toBeInTheDocument(); expect(screen.getByText("Arla")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Brand/), { target: { value: "Local Dairy" } });
    expect(screen.getByRole("button", { name: "Approve & next" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save corrections" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("hotel-a", expect.objectContaining({ patch: { brand: "Local Dairy" } })));
    expect(properties.onApprove).not.toHaveBeenCalled();
  });
  it("recognizes kg in the review selector and offers it as a correction", () => {
    render(<SupplierImportProductReview {...props(row({ product: { ...product, purchaseUnit: "kg" } }))} />);
    expect(screen.getByRole("combobox", { name: "Purchase unit" })).toHaveValue("kg");
    expect(screen.queryByText(/Unrecognized source unit/)).not.toBeInTheDocument();
    fireEvent.focus(screen.getByRole("combobox", { name: "Purchase unit" }));
    expect(screen.getByRole("option", { name: "kg", exact: true })).toBeInTheDocument();
  });
  it("does not repeat null-to-value differences for new products", () => {
    render(<SupplierImportProductReview {...props(row({ changes: Object.entries(product).map(([field, after]) => ({ field, before: null, after })) }))} />);
    expect(screen.queryByRole("region", { name: "Proposed changes" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Product name")).toHaveValue(product.supplierProductName);
  });
  it("saves only a changed name without freezing package, VAT or price fields as human corrections", async () => {
    const properties = props(); mocks.save.mockResolvedValue({ row: row({ reviewRevision: 2, product: { ...product, supplierProductName: "Reviewed Butter" } }) });
    render(<SupplierImportProductReview {...properties} />); fireEvent.change(screen.getByLabelText("Product name"), { target: { value: "Reviewed Butter" } }); fireEvent.click(screen.getByRole("button", { name: "Save corrections" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("hotel-a", { jobId: "job-a", rowId: "r-000001", expectedReviewRevision: 1, patch: { supplierProductName: "Reviewed Butter" } }));
    expect(Object.hasOwn(mocks.save.mock.calls[0][1].patch, "purchaseUnit")).toBe(false);
  });
  it("revalidates a previous failed attempt without inventing field changes or approving stale values", async () => {
    const initial = row({ lastOutcome: { status: "blocked", error: { code: "aborted", message: "The supplier product changed." } } });
    mocks.save.mockResolvedValue({ row: row({ reviewRevision: 2 }) });
    const properties = props(initial); render(<SupplierImportProductReview {...properties} />);
    expect(screen.getByRole("region", { name: "Previous import attempt" })).toHaveTextContent("Revalidate");
    expect(screen.getByRole("button", { name: "Approve & next" })).toBeDisabled(); fireEvent.click(screen.getByRole("button", { name: "Revalidate proposal" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("hotel-a", { jobId: "job-a", rowId: "r-000001", expectedReviewRevision: 1, patch: {} }));
    expect(properties.onApprove).not.toHaveBeenCalled(); expect(properties.onCorrected).toHaveBeenCalledWith(row({ reviewRevision: 2 }));
  });
  it("shows only actual update differences, with readable current and proposed values", () => {
    render(<SupplierImportProductReview {...props(row({ category: "changed", previousProduct: product, changes: [{ field: "supplierProductName", before: "OLD BUTTER", after: "Rochefort Boter 10g" }, { field: "pricePerPurchaseUnit", before: 7, after: 8 }, { field: "vatRate", before: 0.06, after: 0.06 }] }))} />);
    const differences = screen.getByRole("region", { name: "Proposed changes" });
    expect(differences).toHaveTextContent("OLD BUTTER"); expect(differences).toHaveTextContent("Rochefort Boter 10g"); expect(differences).toHaveTextContent("Package price"); expect(differences).not.toHaveTextContent("VAT rate");
    expect(screen.getByText("Product 1 of 40")).toBeInTheDocument(); expect(screen.getByLabelText("Supplier SKU")).toBeDisabled(); expect(screen.getByLabelText("Content unit")).toBeDisabled();
  });
  it("renders confirmed transformations quietly but requires explicit acknowledgment of assumptions", async () => {
    const properties = props(row({ normalizationFindings: [{ field: "purchaseUnit", code: "purchase-label-normalized", severity: "info", before: "DS", after: "Box", provenance: "source", message: "The package code was normalized." }, { field: "supplierProductName", code: "approved-name-expansion", severity: "warning", message: "Confirm the Rochefort brand expansion.", provenance: "approved-name-expansion" }], packInference: { piecesPerPurchaseUnit: 100, pieceQuantity: 10, pieceUnit: "g", provenance: "source-name" } }));
    render(<SupplierImportProductReview {...properties} />);
    expect(screen.queryByText("The package code was normalized.")).not.toBeInTheDocument(); expect(screen.getByText("100 pieces × 10 g = 1 kg per Box.")).toBeInTheDocument(); expect(screen.getByText(/does not create a separately purchasable piece option/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve & next" })).toBeDisabled(); fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ })); await act(async () => fireEvent.click(screen.getByRole("button", { name: "Approve & next" }))); expect(properties.onApprove).toHaveBeenCalledWith(properties.row);
  });
  it("keeps absent purchase prices unknown, permits inactive concepts and recognizes an explicit zero", () => {
    const properties = props(row({ product: { ...product, pricePerPurchaseUnit: null }, issues: [{ field: "pricePerPurchaseUnit", code: "unknown", severity: "warning", message: "The purchase price is unknown." }] }));
    const view = render(<SupplierImportProductReview {...properties} />);
    expect(screen.getByText("Purchase price is missing")).toBeInTheDocument(); expect(screen.getByLabelText("Package price")).toHaveValue(null); expect(screen.queryByText("The purchase price is unknown.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ })); expect(screen.getByRole("button", { name: "Approve & next" })).toBeEnabled();
    view.rerender(<SupplierImportProductReview {...props(row({ reviewRevision: 2, product: { ...product, pricePerPurchaseUnit: 0 } }))} />);
    expect(screen.queryByText("Purchase price is missing")).not.toBeInTheDocument(); expect(screen.getByLabelText("Package price")).toHaveValue(0);
  });
  it("saves blank numeric fields as null with exact VAT and cannot approve dirty or stale revisions", async () => {
    const initial = row(); let final;
    mocks.save.mockImplementation(async (_hotel, input) => ({ row: final = row({ reviewRevision: 2, product: { ...product, ...input.patch } }) }));
    const approve = vi.fn();
    function Harness() { const [value, setValue] = useState(initial); return <SupplierImportProductReview {...props(value)} onCorrected={setValue} onApprove={approve} />; }
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Package price"), { target: { value: "" } }); fireEvent.change(screen.getByLabelText("VAT rate (%)"), { target: { value: "5.6" } });
    expect(screen.getByRole("button", { name: "Approve & next" })).toBeDisabled(); fireEvent.click(screen.getByRole("button", { name: "Save corrections" }));
    await waitFor(() => expect(screen.getByLabelText("VAT rate (%)")).toHaveValue(5.6)); await waitFor(() => expect(screen.getByText("Purchase price is missing")).toBeInTheDocument());
    expect(mocks.save).toHaveBeenCalledWith("hotel-a", expect.objectContaining({ jobId: "job-a", rowId: "r-000001", expectedReviewRevision: 1, patch: { pricePerPurchaseUnit: null, vatRate: 0.056 } }));
    expect(approve).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ })); await act(async () => fireEvent.click(screen.getByRole("button", { name: "Approve & next" }))); expect(approve).toHaveBeenCalledWith(final);
  });
  it("requires the acknowledged correction revision to reach the parent before approving", async () => {
    const properties = props(); mocks.save.mockResolvedValue({ row: row({ reviewRevision: 2, product: { ...product, supplierProductName: "Corrected Butter" } }) }); render(<SupplierImportProductReview {...properties} />);
    fireEvent.change(screen.getByLabelText("Product name"), { target: { value: "Corrected Butter" } }); fireEvent.click(screen.getByRole("button", { name: "Save corrections" }));
    await waitFor(() => expect(properties.onCorrected).toHaveBeenCalled()); await waitFor(() => expect(screen.getByRole("button", { name: "Save for later" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Approve & next" })).toBeDisabled(); expect(properties.onApprove).not.toHaveBeenCalled();
  });
  it("saves corrections before moving the product aside without approving it", async () => {
    const properties = props(); const corrected = row({ reviewRevision: 2, product: { ...product, supplierProductName: "Reviewed Butter" } }); mocks.save.mockResolvedValue({ row: corrected }); render(<SupplierImportProductReview {...properties} />);
    fireEvent.change(screen.getByLabelText("Product name"), { target: { value: "Reviewed Butter" } }); fireEvent.click(screen.getByRole("button", { name: "Save for later" }));
    await waitFor(() => expect(properties.onLater).toHaveBeenCalledWith(corrected)); expect(properties.onCorrected).toHaveBeenCalledWith(corrected); expect(properties.onApprove).not.toHaveBeenCalled();
  });
  it("does not discard dirty edits during a same-revision status refresh", () => {
    const properties = props(); const view = render(<SupplierImportProductReview {...properties} />); fireEvent.change(screen.getByLabelText("Product name"), { target: { value: "Unsaved local name" } });
    view.rerender(<SupplierImportProductReview {...properties} row={row()} />); expect(screen.getByLabelText("Product name")).toHaveValue("Unsaved local name"); expect(screen.getByRole("button", { name: "Approve & next" })).toBeDisabled();
    view.rerender(<SupplierImportProductReview {...properties} row={row({ reviewRevision: 2 })} />); expect(screen.getByLabelText("Product name")).toHaveValue(product.supplierProductName);
  });
  it("blocks permanent source errors while retaining escaped source evidence and correction fields", () => {
    render(<SupplierImportProductReview {...props(row({ category: "blocked", canApprove: false, issues: [{ field: "sourceAnchors", code: "evidence-quote-absent", severity: "error", message: "The source quote could not be verified. Editing product fields cannot verify it." }], sourceAnchors: [{ anchor: "Unknown source", verified: false, quote: '<img src=x onerror="alert(1)">' }] }))} />);
    expect(screen.getByRole("region", { name: "Required corrections" })).toHaveTextContent("Editing product fields cannot verify it"); expect(screen.getByRole("button", { name: "Approve & next" })).toBeDisabled(); expect(screen.getByLabelText("Product name")).toBeEnabled();
    expect(screen.getByText(/Unknown source · unverified reference/)).toBeInTheDocument(); expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeInTheDocument(); expect(screen.getByRole("article").querySelector("img")).toBeNull(); expect(screen.getByText(/No extracted source text is available/)).toBeInTheDocument();
  });
  it("leaves a failed correction dirty and does not approve or advance the product", async () => {
    const properties = props(); mocks.save.mockRejectedValue(new Error("The gross price requires a VAT rate.")); render(<SupplierImportProductReview {...properties} />); fireEvent.change(screen.getByLabelText("Price basis"), { target: { value: "gross" } }); fireEvent.click(screen.getByRole("button", { name: "Save for later" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The gross price requires a VAT rate.")); expect(screen.getByRole("button", { name: "Approve & next" })).toBeDisabled(); expect(properties.onLater).not.toHaveBeenCalled(); expect(properties.onApprove).not.toHaveBeenCalled();
  });
  it("fences a save response when the selected hotel changes or access is revoked", async () => {
    let resolve; mocks.save.mockReturnValue(new Promise((done) => { resolve = done; })); const properties = props(); const view = render(<SupplierImportProductReview {...properties} />); fireEvent.change(screen.getByLabelText("Product name"), { target: { value: "Changed Butter" } }); fireEvent.click(screen.getByRole("button", { name: "Save for later" }));
    view.rerender(<SupplierImportProductReview {...properties} hotelUid="hotel-b" />); await act(async () => resolve({ row: row({ reviewRevision: 2 }) })); expect(properties.onCorrected).not.toHaveBeenCalled(); expect(properties.onLater).not.toHaveBeenCalled();
    mocks.permissions = []; view.rerender(<SupplierImportProductReview {...properties} hotelUid="hotel-b" />); expect(screen.getByLabelText("Product name")).toBeDisabled(); expect(screen.getByRole("button", { name: "Skip" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Approve & next" })).toBeDisabled();
  });
  it("ignores late save responses after unmount and avoids duplicate pending actions", async () => {
    let resolve; mocks.save.mockReturnValue(new Promise((done) => { resolve = done; })); const properties = props(); const view = render(<SupplierImportProductReview {...properties} />); fireEvent.change(screen.getByLabelText("Package price"), { target: { value: "9" } }); fireEvent.click(screen.getByRole("button", { name: "Save corrections" })); fireEvent.click(screen.getByRole("button", { name: "Save for later" }));
    expect(mocks.save).toHaveBeenCalledTimes(1); expect(screen.getByRole("button", { name: "Skip" })).toBeDisabled(); view.unmount(); await act(async () => resolve({ row: row({ reviewRevision: 2 }) })); expect(properties.onCorrected).not.toHaveBeenCalled(); expect(properties.onLater).not.toHaveBeenCalled();
  });
  it("searches only the selected hotel's catalog through an accessible combobox", async () => {
    mocks.permissions.push("catalogproducts.read"); mocks.catalog.mockResolvedValue({ products: [{ id: "butter", name: "Butter", baseUnit: "g" }, { id: "archived", name: "Old Butter", baseUnit: "g", archived: true }] }); render(<SupplierImportProductReview {...props()} />);
    await waitFor(() => expect(mocks.catalog).toHaveBeenCalledWith("hotel-a", { pageSize: 50, searchTerm: "" })); fireEvent.focus(screen.getByRole("combobox", { name: "Catalog product" })); await waitFor(() => expect(screen.getByRole("option", { name: "Butter (g)" })).toBeInTheDocument()); expect(screen.queryByRole("option", { name: "Old Butter (g)" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Catalog product" }), { target: { value: "but" } }); await waitFor(() => expect(mocks.catalog).toHaveBeenCalledWith("hotel-a", { pageSize: 50, searchTerm: "but" })); fireEvent.click(screen.getByRole("option", { name: "Butter (g)" })); expect(screen.getByRole("combobox", { name: "Catalog product" })).toHaveValue("Butter (g)"); expect(screen.getByRole("button", { name: "Approve & next" })).toBeDisabled();
  });
  it("offers all canonical English purchase units and requires a real selection", () => {
    render(<SupplierImportProductReview {...props(row({ product: { ...product, purchaseUnit: "ZK" } }))} />); expect(screen.getByText(/Unrecognized source unit: ZK/)).toBeInTheDocument(); fireEvent.focus(screen.getByRole("combobox", { name: "Purchase unit" })); expect(screen.getByRole("option", { name: "Bag" })).toBeInTheDocument(); expect(screen.getByRole("option", { name: "Bucket" })).toBeInTheDocument(); expect(screen.getByRole("option", { name: "Tray" })).toBeInTheDocument(); expect(screen.getByRole("option", { name: "Jar" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "Bag" })); expect(screen.getByRole("combobox", { name: "Purchase unit" })).toHaveValue("Bag"); expect(screen.getByRole("button", { name: "Approve & next" })).toBeDisabled();
  });
  it("does not turn an invalid or stale package inference into a purchasable piece option", () => {
    render(<SupplierImportProductReview {...props(row({ product: { ...product, baseUnit: "each" }, packInference: { piecesPerPurchaseUnit: 100, pieceQuantity: 10, pieceUnit: "g", provenance: "source-name" } }))} />); expect(screen.getByText(/cannot be reconciled with the reviewed package content/)).toBeInTheDocument(); expect(screen.queryByText(/= 100 each/)).not.toBeInTheDocument(); expect(screen.getByText(/does not create a separately purchasable piece option/)).toBeInTheDocument();
  });
  it("does not render private provider accounting carried by unrelated row properties", () => {
    render(<SupplierImportProductReview {...props(row({ model: "expensive-provider-model", usage: { actualCostUsd: 12 }, originalInput: { ...product, tokenCount: 100 } }))} />); const article = screen.getByRole("article"); expect(article).not.toHaveTextContent("expensive-provider-model"); expect(article).not.toHaveTextContent("actualCostUsd");
  });
});

it("exposes a physical unit increase caused by a smaller package at the same purchase price", () => {
  const previous = { ...product, baseUnitsPerPurchaseUnit: 1.25 }, changed = row({ category: "changed", previousProduct: previous, changes: [{ field: "baseUnitsPerPurchaseUnit", before: 1.25, after: 1 }], recurringReview: { category: "packaging-change", confirmsUnitPrice: true, sourceIssuedOn: "2026-10-01", formatStatus: "confirmed", physicalPriceComparison: { before: 6.4, after: 8, percentChange: 25, unit: "kg", currency: "EUR", comparable: true }, assortmentMode: "partial" } });
  render(<SupplierImportProductReview {...props(changed)} />);
  const comparison = screen.getByRole("region", { name: "Recurring price review" });
  expect(comparison).toHaveTextContent("6.4"); expect(comparison).toHaveTextContent("8 EUR/kg"); expect(comparison).toHaveTextContent("+25%"); expect(comparison).toHaveTextContent("An unchanged box price");
  expect(comparison).toHaveTextContent("Validity is unknown");
});
it("does not present a statistics source as confirming the preserved unit price", () => {
  render(<SupplierImportProductReview {...props(row({ category: "unchanged", previousProduct: product, recurringReview: { category: "unchanged", confirmsUnitPrice: false, sourceIssuedOn: null, formatStatus: "confirmed", physicalPriceComparison: { comparable: false, before: null, after: null, unit: "kg", currency: "EUR", reason: "No source-backed purchase price." } } }))} />);
  expect(screen.getByRole("region", { name: "Recurring price review" })).toHaveTextContent("Existing price confirmation dates remain unchanged"); expect(screen.getByText(/No source-backed purchase price/)).toBeInTheDocument();
});
