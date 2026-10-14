import { describe, expect, it } from "vitest";
import { supplierAiImportCategoryCounts, supplierAiImportSettings, supplierAiImportSummary, supplierAiReviewRowLabel } from "./supplierAiImportSummary";
const summary = () => ({ version: 2, totalRows: 250, normalizedRows: 220, assumptionRows: 75, unknownPriceRows: 40, blockedNormalizationRows: 5, inferredPieceRows: 60, missingRequiredRows: 8, findings: [{ field: "pricingModel", code: "pricing-model-missing", severity: "warning", message: "Purchase pricing must be reviewed.", count: 40, rowIds: ["r-000001", "r-000050"] }] });
const counts = { new: 200, changed: 30, unchanged: 12, blocked: 8 };
describe("complete supplier import summary boundary", () => {
  it("keeps complete all-product totals and overlapping findings without relying on a loaded review page", () => {
    expect(supplierAiImportSummary(summary(), { totalRows: 250, counts })).toEqual(summary());
    expect(supplierAiImportSummary({ ...summary(), usage: { actualCostUsd: 10 }, model: "expensive", budget: 99, rows: Array(100).fill({ rawDocument: "private" }) }, { counts })).toEqual(summary());
  });
  it("does not turn an old, incomplete or unreconciled summary into zero", () => {
    expect(supplierAiImportSummary(null)).toBeNull(); expect(supplierAiImportSummary({ version: 1, totalRows: 250 })).toBeNull();
    const incomplete = summary(); delete incomplete.missingRequiredRows; expect(supplierAiImportSummary(incomplete)).toBeNull();
    expect(supplierAiImportSummary(summary(), { totalRows: 100, counts })).toBeNull(); expect(supplierAiImportSummary(summary(), { counts: { ...counts, new: 100 } })).toBeNull();
  });
  it("rejects malformed counters and unbounded or duplicate finding groups", () => {
    for (const patch of [{ totalRows: 1001 }, { unknownPriceRows: null }, { assumptionRows: -1 }, { normalizedRows: 251 }, { inferredPieceRows: 1.5 }, { findings: Array(21).fill(summary().findings[0]) }, { findings: [...summary().findings, ...summary().findings] }]) expect(supplierAiImportSummary({ ...summary(), ...patch })).toBeNull();
    for (const patch of [{ count: 251 }, { count: 0 }, { rowIds: ["a", "b", "c", "d"] }, { rowIds: ["x/y"] }, { rowIds: ["same", "same"] }, { severity: "success" }]) expect(supplierAiImportSummary({ ...summary(), findings: [{ ...summary().findings[0], ...patch }] })).toBeNull();
  });
  it("retains commercial pricing-model checks while redacting operator accounting from hostile messages", () => {
    const safe = supplierAiImportSummary(summary()); expect(safe.findings[0].field).toBe("pricingModel"); expect(safe.findings[0].message).toBe("Purchase pricing must be reviewed.");
    for (const message of ["AI API estimated cost $0.01", "OpenAI provider tokens 5000", "AI model gpt-6-luna", "Model gpt-4o 0.01", "Model gpt-5mini 0.01", "reservedCostUsd 0.25", "API key sk-secretvalue"]) {
      const result = supplierAiImportSummary({ ...summary(), findings: [{ ...summary().findings[0], message }] });
      expect(result.findings[0].message).toBe("Your hotel administrator can help with this import check."); expect(JSON.stringify(result)).not.toContain(message);
    }
    expect(supplierAiImportSummary({ ...summary(), findings: [{ ...summary().findings[0], message: "Purchase-cost comparisons remain unavailable until a price is provided." }] }).findings[0].message).toContain("Purchase-cost");
    expect(supplierAiImportSummary({ ...summary(), findings: [{ ...summary().findings[0], field: "usage" }] })).toBeNull();
  });
  it("projects only the immutable commercial import settings, preserving unknown and zero VAT distinctly", () => {
    const settings = { policyVersion: 2, priceBasis: "gross", currency: "EUR", vatRate: null };
    expect(supplierAiImportSettings({ ...settings, model: "hidden", apiKey: "hidden" })).toEqual(settings);
    expect(supplierAiImportSettings({ ...settings, vatRate: 0 })).toEqual({ ...settings, vatRate: 0 });
    expect(supplierAiImportSettings({ ...settings, priceBasis: "unknown" })).toEqual({ ...settings, priceBasis: "unknown" });
    for (const value of [null, { ...settings, policyVersion: 1 }, { ...settings, vatRate: undefined }, { ...settings, vatRate: 6 }, { ...settings, vatRate: "0.06" }, { ...settings, currency: "eur" }, { ...settings, priceBasis: "including tax" }]) expect(supplierAiImportSettings(value)).toBeNull();
  });
  it("validates all category counts against the full total when it is available", () => {
    expect(supplierAiImportCategoryCounts(counts, 250)).toEqual(counts); expect(supplierAiImportCategoryCounts(counts, 100)).toBeNull(); expect(supplierAiImportCategoryCounts(null, 250)).toBeNull();
    expect(supplierAiReviewRowLabel("r-000250")).toBe("Review row 250");
  });
});
