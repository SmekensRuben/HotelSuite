import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseSupplierProductRows, supplierProductExportRow, SUPPLIER_PRODUCT_EXPORT_HEADERS, SUPPLIER_PRODUCT_TEMPLATE_HEADERS, SUPPLIER_PRODUCT_TEMPLATE_ROW } from "./supplierProductTransfer";

const offer = {
  id: "stable-offer", revision: 7, supplierId: "supplier-identity", supplierSku: "000040", supplierProductName: "Orange juice case", gtin: "036000291452",
  currency: "EUR", pricingModel: "Per Purchase Unit", priceBasis: "gross", vatRate: 0.06, priceValidFrom: "2026-10-01", priceValidUntil: "2026-12-31",
  pricePerBaseUnit: null, pricePerPurchaseUnit: 0, purchaseUnit: "Case of 6", baseUnit: "ml", baseUnitsPerPurchaseUnit: 6000, catalogProductId: "orange-catalog",
  purchaseOptions: [{ id: "single-bottle", purchaseUnit: "Bottle", gtin: "06291041500213", baseUnitsPerPurchaseUnit: 1000, pricePerPurchaseUnit: null }],
  active: false, imageUrl: "https://supplier.example/juice.jpg", image: { assetId: "managed-asset", status: "ready", policyVersion: 1 }, imageRevision: 3, createdAt: { seconds: 1790841600 }, createdBy: "original-author", updatedBy: "last-editor", supplierName: "Juice supplier",
};
function roundTrip(rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows, { header: SUPPLIER_PRODUCT_EXPORT_HEADERS }), "SupplierProducts");
  const saved = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  const loaded = XLSX.read(saved, { type: "array" });
  return XLSX.utils.sheet_to_json(loaded.Sheets.SupplierProducts, { defval: "", raw: false });
}
describe("supplier product workbook boundary", () => {
  it("round-trips actual XLSX bytes with stable IDs, revisions, package barcodes, zero prices and unknown option prices", () => {
    const rows = roundTrip([supplierProductExportRow(offer)]);
    expect(rows[0].supplierSku).toBe("000040");
    expect(rows[0].gtin).toBe("036000291452");
    expect(rows[0].createdAt).toBe("2026-10-01T08:00:00.000Z");
    const [parsed] = parseSupplierProductRows(rows);
    expect(parsed).toMatchObject({ documentId: "stable-offer", revision: 7, supplierSku: "000040", gtin: "036000291452", currency: "EUR", priceBasis: "gross", vatRate: 0.06, pricePerPurchaseUnit: 0, pricePerBaseUnit: null, baseUnit: "ml", baseUnitsPerPurchaseUnit: 6000, catalogProductId: "orange-catalog", active: false, priceValidFrom: "2026-10-01", priceValidUntil: "2026-12-31" });
    expect(parsed.purchaseOptions).toEqual([{ id: "single-bottle", purchaseUnit: "Bottle", gtin: "06291041500213", baseUnitsPerPurchaseUnit: 1000, pricePerPurchaseUnit: null }]);
    expect(parsed).not.toHaveProperty("createdBy");
    expect(parsed).not.toHaveProperty("updatedBy");
    expect(parsed).not.toHaveProperty("supplierName");
    expect(rows[0]).toMatchObject({ managedImageAssetId: "managed-asset", managedImageStatus: "ready", managedImagePolicyVersion: "1", imageRevision: "3" });
    expect(parsed).not.toHaveProperty("managedImageAssetId");
    expect(parsed).not.toHaveProperty("image");
    expect(parsed).not.toHaveProperty("imageRevision");
  });
  it("does not invent a currency, a missing price or a contract validity bound", () => {
    const row = supplierProductExportRow({ ...offer, currency: null, pricePerPurchaseUnit: null, vatRate: null, priceValidFrom: null, priceValidUntil: null });
    expect(row.currency).toBe(""); expect(row.pricePerPurchaseUnit).toBe(""); expect(row.vatRate).toBe("");
    expect(parseSupplierProductRows(roundTrip([row]))[0]).toMatchObject({ currency: "", pricePerPurchaseUnit: null, vatRate: null, priceValidFrom: null, priceValidUntil: null });
    expect(SUPPLIER_PRODUCT_TEMPLATE_ROW.currency).toBe("");
    expect(SUPPLIER_PRODUCT_TEMPLATE_HEADERS).not.toContain("revision");
    expect(SUPPLIER_PRODUCT_TEMPLATE_HEADERS).not.toContain("createdBy");
  });
  it("intentionally exports legacy missing revision as zero but rejects corrupt stored revisions", () => {
    expect(supplierProductExportRow({ ...offer, revision: undefined }).revision).toBe(0);
    for (const revision of [null, -1, 1.5, "7", NaN, Number.MAX_SAFE_INTEGER]) expect(() => supplierProductExportRow({ ...offer, revision })).toThrow(/invalid revision/);
  });
  it("does not silently drop an incomplete non-empty row in a mixed workbook", () => {
    expect(() => parseSupplierProductRows([supplierProductExportRow(offer), { supplierId: "supplier", supplierProductName: "Missing SKU" }])).toThrow("Row 3: Supplier, SKU and product name are required");
    expect(parseSupplierProductRows([{}, supplierProductExportRow(offer)])).toHaveLength(1);
  });
  it.each([
    ["revision", "0.5", /non-negative whole number/], ["pricePerPurchaseUnit", "Infinity", /finite number/],
    ["active", "yes", /true or false/], ["purchaseOptions", "{}", /JSON array/], ["variants", "not-json", /valid JSON array/],
    ["purchaseOptions", '[{"id":"default"}]', /cannot be default/], ["purchaseOptions", '[{"id":"x"},{"id":"x"}]', /unique/],
    ["hasVariants", "true", /manual review/],
  ])("rejects malformed %s instead of changing its meaning", (field, value, message) => {
    expect(() => parseSupplierProductRows([{ ...supplierProductExportRow(offer), [field]: value }])).toThrow(message);
  });
  it("keeps GTIN absent for old workbooks and rejects duplicate stable or supplier/SKU identities", () => {
    const row = supplierProductExportRow(offer); delete row.gtin;
    expect(parseSupplierProductRows([row])[0]).not.toHaveProperty("gtin");
    expect(() => parseSupplierProductRows([row, row])).toThrow(/duplicate product identity/);
    delete row.documentId;
    expect(() => parseSupplierProductRows([row, row])).toThrow(/duplicate product identity/);
  });
});
