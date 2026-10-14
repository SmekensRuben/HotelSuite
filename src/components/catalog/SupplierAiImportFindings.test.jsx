import React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SupplierAiImportFindings from "./SupplierAiImportFindings";
const summary = () => ({ version: 2, totalRows: 250, normalizedRows: 230, assumptionRows: 75, unknownPriceRows: 80, blockedNormalizationRows: 5, inferredPieceRows: 25, missingRequiredRows: 12, findings: [{ field: "pricePerPurchaseUnit", code: "price-source-missing", severity: "warning", message: "Purchase prices are absent from the supplied document.", count: 80, rowIds: ["r-000001", "r-000101", "r-000250"] }, { field: "pricingModel", code: "pricing-model-needs-review", severity: "error", message: "Review the purchase pricing before importing.", count: 5, rowIds: ["r-000249"] }] });
const counts = { new: 200, changed: 25, unchanged: 13, blocked: 12 };
describe("all-product supplier import findings", () => {
  it("shows all 250 products and classifications independently from review-page pagination", () => {
    render(<SupplierAiImportFindings summary={summary()} counts={counts} totalRows={250} />);
    expect(screen.getByRole("heading", { name: "Overview of all 250 extracted products" })).toBeInTheDocument();
    const overview = screen.getByRole("region", { name: "Complete import overview" }); expect(overview).toHaveTextContent("New200"); expect(overview).toHaveTextContent("Changed25"); expect(overview).toHaveTextContent("Unknown purchase prices80"); expect(overview).toHaveTextContent("Assumptions to review75"); expect(overview).toHaveTextContent("Required details missing12");
    expect(screen.getByText("Examples: Review row 1, Review row 101, Review row 250")).toBeInTheDocument(); expect(screen.getByText(/Review counts can overlap/)).toBeInTheDocument();
  });
  it("states that legacy or unreconciled totals are unavailable instead of displaying zero", () => {
    const view = render(<SupplierAiImportFindings summary={null} counts={counts} totalRows={250} />);
    expect(screen.getByRole("status")).toHaveTextContent("A complete overview is unavailable"); expect(screen.queryByText("Unknown purchase prices")).not.toBeInTheDocument();
    view.rerender(<SupplierAiImportFindings summary={{ ...summary(), unknownPriceRows: undefined }} counts={counts} />); expect(screen.getByRole("status")).toHaveTextContent("unavailable");
    view.rerender(<SupplierAiImportFindings summary={null} loading />); expect(screen.getByRole("status")).toHaveTextContent("Preparing the overview of every extracted product");
  });
  it("does not treat a loaded page total or inconsistent categories as the full-document overview", () => {
    render(<SupplierAiImportFindings summary={summary()} counts={{ ...counts, new: 50 }} totalRows={100} />);
    expect(screen.getByRole("status")).toHaveTextContent("unavailable"); expect(screen.queryByRole("heading", { name: "Overview of all 250 extracted products" })).not.toBeInTheDocument();
  });
  it("shows commercial pricing checks while hiding provider costs, models and unsafe markup", () => {
    const value = summary(); value.findings.push({ field: "baseUnit", code: "unit-needs-review", severity: "warning", message: '<img src=x onerror="alert(1)">', count: 1, rowIds: ["r-000002"] }); value.model = "gpt-6-luna"; value.usage = { actualCostUsd: 0.25 }; value.findings.push({ field: "purchaseUnit", code: "needs-review", severity: "info", message: "Provider estimated cost $0.25 and tokens 5000", count: 1, rowIds: [] });
    render(<SupplierAiImportFindings summary={value} counts={counts} />);
    expect(screen.getByText("Review the purchase pricing before importing.")).toBeInTheDocument(); expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeInTheDocument(); expect(screen.getByText("Your hotel administrator can help with this import check.")).toBeInTheDocument();
    const overview = screen.getByRole("region", { name: "Complete import overview" }); expect(overview.querySelector("img")).toBeNull(); expect(within(overview).queryByText(/gpt-6-luna|estimated cost|5000|0.25/)).not.toBeInTheDocument();
  });
});
