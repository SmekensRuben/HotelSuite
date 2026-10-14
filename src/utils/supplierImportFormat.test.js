import { it, expect } from "vitest";
import { normalizeSupplierFormatInterpretation, projectSupplierFormatCandidate, validSupplierDate } from "./supplierImportFormat";
const profile = { version: 1, header: ["Article", "Name", "Box price"], sheetName: null, columns: { supplierSku: 0, supplierProductName: 1, pricePerPurchaseUnit: 2 }, defaults: { currency: "EUR", priceBasis: "net" }, assortmentMode: "partial", documentPurpose: "price-list", decimalSeparator: ",", dateFormat: "DD/MM/YYYY" };
it("keeps unconfirmed columns editable even when the article-number mapping is missing", () => {
  const value = { ...profile, columns: {}, sourceFormat: "csv", formatFingerprint: "fingerprint" };
  expect(projectSupplierFormatCandidate(value).columns).toEqual({});
  expect(() => normalizeSupplierFormatInterpretation({ ...profile, columns: {} })).toThrow(/interpretation/);
});
it("canonicalizes key order for confirmed profile acknowledgment and rejects duplicated mappings", () => {
  const left = normalizeSupplierFormatInterpretation(profile);
  const right = normalizeSupplierFormatInterpretation({ ...profile, columns: { pricePerPurchaseUnit: 2, supplierProductName: 1, supplierSku: 0 }, defaults: { priceBasis: "net", currency: "EUR" } });
  expect(JSON.stringify(left)).toBe(JSON.stringify(right));
  expect(() => normalizeSupplierFormatInterpretation({ ...profile, columns: { supplierSku: 0, pricePerPurchaseUnit: 0 } })).toThrow();
  expect(() => normalizeSupplierFormatInterpretation({ ...profile, defaults: { password: "fictional" } })).toThrow();
  expect(validSupplierDate("2026-02-30")).toBe(false); expect(validSupplierDate("2028-02-29")).toBe(true);
});
