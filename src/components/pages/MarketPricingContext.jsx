import React from "react";
import { Card } from "../layout/Card";

const money = (value) => value === null || value === undefined ? "—" : `€${Number(value).toFixed(2)}`;
const percent = (value) => value === null || value === undefined ? "—" : `${(Number(value) * 100).toFixed(1)}%`;
const gap = (floor, value) => floor === null || value === null ? "—" : percent((floor - value) / value);

export default function MarketPricingContext({ snapshot, economicFloorInclVat = null, stale = false }) {
  if (!snapshot) return <Card><h3 className="text-lg font-semibold">Market Pricing Context</h3><p className="mt-2 text-sm text-gray-600">Market pricing context is unavailable. Configure a compset and run the analysis.</p></Card>;
  const summary = snapshot.groupStaySummary || {};
  return <Card className={`border bg-white p-0 shadow-sm ${stale ? "border-amber-300" : "border-gray-200"}`}>
    <div className="border-b border-gray-200 px-6 py-5">
      <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">Public market positioning · informational only</p>
      <h3 className="mt-1 text-lg font-semibold">Market Pricing Context</h3>
      <p className="mt-1 text-sm text-gray-600">Consumer-facing Lighthouse prices include VAT and are never used in contribution or Economic Floor calculations. Snapshot {snapshot.lighthouseSnapshotDate || "unavailable"}.</p>
      {stale && <p className="mt-2 font-semibold text-amber-800">This snapshot belongs to the stale analysis and is historical, not current market context.</p>}
    </div>
    <div className="grid gap-3 p-6 sm:grid-cols-2 lg:grid-cols-4">
      {[["Economic Floor", economicFloorInclVat], ["Weighted Own Public Rate", summary.weightedOwnPublicRateInclVat], ["Weighted Market Reference", summary.weightedMarketReferenceInclVat], ["Weighted Compset Median", summary.weightedCompsetMedianInclVat]].map(([label, value]) => <div key={label} className="rounded-lg bg-gray-50 p-3"><p className="text-xs uppercase text-gray-500">{label} · incl. VAT</p><p className="mt-1 text-xl font-semibold">{money(value)}</p>{label !== "Economic Floor" && <p className="text-xs text-gray-500">Floor gap {gap(economicFloorInclVat, value)}</p>}</div>)}
    </div>
    <div className="overflow-x-auto border-t border-gray-200"><table className="min-w-[1050px] w-full text-sm"><thead className="bg-gray-50 text-left text-xs uppercase text-gray-500"><tr>{["Date", "Economic Floor", "Own Public Rate", "Weighted Market Reference", "Compset Median", "Compset Low", "Compset High", "Market Demand", "My OTB", "Coverage", "Confidence"].map((heading) => <th className="whitespace-nowrap px-4 py-3" key={heading}>{heading}</th>)}</tr></thead><tbody className="divide-y divide-gray-100">{snapshot.stayDates?.map((date) => <tr key={date.stayDate}><td className="px-4 py-3 font-medium">{date.stayDate}</td><td className="px-4 py-3">{money(economicFloorInclVat)}</td><td className="px-4 py-3">{money(date.ownPublicRateInclVat)}{date.ownPublicRateInclVat === null && <span className="block text-xs text-amber-700">Own rate unavailable</span>}</td><td className="px-4 py-3">{money(date.weightedCompsetReferenceInclVat)}</td><td className="px-4 py-3">{money(date.compsetMedianInclVat)}</td><td className="px-4 py-3">{money(date.compsetLowInclVat)}</td><td className="px-4 py-3">{money(date.compsetHighInclVat)}</td><td className="px-4 py-3">{percent(date.marketDemand)}</td><td className="px-4 py-3">{percent(date.myOtb)}</td><td className="px-4 py-3">{percent(date.coverage)}</td><td className="px-4 py-3 font-semibold">{date.marketPricingConfidence}</td></tr>)}</tbody></table></div>
  </Card>;
}
