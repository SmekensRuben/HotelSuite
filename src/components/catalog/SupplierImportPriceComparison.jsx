import React from "react";

const number = (value) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en", { maximumFractionDigits: 4 }) : "Unknown";
export const supplierReviewCategoryLabel = (row) => ({ "price-change": "Price change", "packaging-change": "Package change", "new-article": "New article", exception: "Exception", confirmation: "Price confirmation", unchanged: "Unchanged", "product-change": "Article update" })[row.recurringReview?.category] || ({ new: "New product", changed: "Proposed update", unchanged: "Unchanged", blocked: "Needs correction" })[row.category] || "Review";

export default function SupplierImportPriceComparison({ comparison, compact = false }) {
  if (!comparison) return null;
  if (!comparison.comparable || !comparison.unit || !comparison.currency) return compact ? <span className="block text-xs text-stone-500">Physical price comparison unavailable</span> : <p className="text-xs text-stone-600">Physical price comparison unavailable. {comparison.reason || "Check currency, net price and compatible physical package content."}</p>;
  const period = typeof comparison.percentChange === "number" ? `${comparison.percentChange > 0 ? "+" : ""}${number(comparison.percentChange)}%` : null;
  const unit = `${comparison.currency}/${comparison.unit}`;
  if (compact) return <span className="mt-1 block text-xs text-stone-600">{number(comparison.before)} → {number(comparison.after)} {unit}{period ? ` (${period})` : ""}</span>;
  return <div className="space-y-2"><p className="text-xs font-semibold text-stone-600">Net price per physical unit</p><p className="flex flex-wrap items-baseline gap-2 text-base"><span className="text-stone-600">{number(comparison.before)}</span><span aria-hidden="true">→</span><strong className="text-brand-950">{number(comparison.after)} {unit}</strong>{period && <span className={`rounded-full px-2 py-1 text-xs font-semibold ${comparison.percentChange > 0 ? "bg-amber-100 text-amber-950" : "bg-green-100 text-green-950"}`}>{period}</span>}</p><p className="text-xs text-stone-600">This comparison includes package content changes. An unchanged box price can still increase the cost per {comparison.unit}.</p></div>;
}
