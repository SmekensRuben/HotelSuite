import React from "react";
import { usePermission } from "../../hooks/usePermission";
import { formatInventoryQuantity } from "./inventoryFormatting";

const guidance = {
  "postings-during-count": "Check the timing of each delivery, movement and overlapping count against the physical quantities. If the cutoff cannot be established, arrange a new count with movements coordinated across the location.",
  "checkpoint-cutoff-unknown": "The counting cutoff is unknown. Ask an inventory supervisor to review source records and arrange a new count for a future baseline.",
  "posting-evidence-incomplete": "Ask an inventory supervisor to reconcile missing or duplicate source evidence. A recount does not repair historical postings.",
  "late-posting-after-closing": "Review the source record and the actual date goods moved. Correct an incorrect receipt or movement through its existing reversal workflow; retain a valid late entry and arrange a new count if the physical baseline is uncertain.",
  "backdated-or-outside-period": "Compare the recorded business date and posting sequence with the physical delivery or movement. Correct an erroneous source through its existing reversal workflow. A valid late entry remains visible.",
  "source-date-unknown": "Check the source record with a receiving or inventory supervisor. Do not infer a business date from its posting time.",
  "receipt-coverage-gap": "Review the receipt's missing catalog link, unit or conversion with a receiving supervisor. Correct the source through a compensating reversal and a new verified receipt when supported; never invent missing quantities.",
  "checkpoint-product-missing": "This article is missing from one count. Its absence is not zero. Include it explicitly in a new physical count; completed counts stay unchanged.",
  "opening-cost-unknown": "The opening count has no usable recorded net cost for this article. Its historical value stays unavailable. Enter a reviewed estimate only in a new count when supported by evidence.",
  "closing-cost-unknown": "The closing count has no usable recorded net cost for this article. Keep its historic value unavailable and review cost evidence for the next count.",
  "receipt-cost-unknown": "Review the frozen receipt cost and currency. Missing cost is not zero; current supplier prices cannot revalue this historical receipt.",
  "manual-cost-unknown": "Review the movement's recorded cost and currency. Missing cost stays unavailable; reverse an incorrect event through the movement workflow and record a corrected event with a reason.",
  "negative-period-basis": "Recorded outgoing quantities exceed the known period sources. Check missing receipts, movement directions and cutoff dates before relying on this comparison.",
  "count-surplus": "The closing quantity exceeds the recorded period basis. Check omitted receipts, transfers and counting units; recount if the physical quantities cannot be verified.",
};

export default function InventoryExceptionReview({ issues = [], hotelUid, locationId, stockCountId, title = "Review inventory exceptions" }) {
  const canReadOrders = usePermission("orders", "read"), canReceive = usePermission("orders", "receive"), canReverseReceipt = usePermission("orders", "finalize");
  const canReadMovements = usePermission("inventorymovements", "read"), canCreateMovements = usePermission("inventorymovements", "create"), canReverseMovements = usePermission("inventorymovements", "reverse");
  const canCreateCounts = usePermission("stockcounts", "create"), canReadCounts = usePermission("stockcounts", "read");
  if (!issues.length) return null;
  const countUrl = (id) => `/catalog/stock-counts/${encodeURIComponent(id)}/locations/${encodeURIComponent(locationId)}`;
  const recountQuery = new URLSearchParams({ hotelUid, locationId, ...(stockCountId ? { recountOf: stockCountId } : {}) });
  return <section aria-label={title} className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
    <h3 className="font-semibold">{title}</h3>
    <p>Reviewing evidence does not clear uncertainty. Completed counts, original movements and saved calculations remain unchanged. Corrections record compensating evidence; a new count establishes a future baseline.</p>
    <ul className="space-y-4">{issues.map((issue, index) => <li key={`${issue.code}:${index}`} className="space-y-2 border-t border-amber-200 pt-3">
      <p className="font-medium">{issue.product ? `${issue.product}: ` : ""}{issue.detail || issue.code}</p>
      <p>{guidance[issue.code] || "Check the original count and movement evidence with an inventory supervisor before relying on this comparison."}</p>
      {(issue.counts || []).map((count) => <p key={count.stockCountId}>{count.stockCountName || count.stockCountId} · {count.businessDate} · checkpoint #{count.sequence}{canReadCounts && <> · <a target="_blank" rel="noopener noreferrer" className="underline" href={countUrl(count.stockCountId)}>Review count events</a></>}</p>)}
      {(issue.evidence || []).length > 0 && <details open={issue.evidence.length <= 3}><summary className="cursor-pointer font-medium">Source events ({issue.evidence.length})</summary>
        <ul className="mt-2 space-y-3">{issue.evidence.map((event) => <li key={event.movementId || event.checkpointId} className="rounded-lg bg-white/70 p-3">
          <p className="font-medium">{event.label} · {event.movementId || event.checkpointId} · posting #{event.sequence}</p>
          <p>Business date: {event.businessDate || "Unknown"}{event.postedAtMillis != null ? ` · Posted: ${new Date(event.postedAtMillis).toLocaleString("en-GB")}` : ""}</p>
          {event.reference && <p>Reference: {event.reference}</p>}
          {event.originalMovementId && <p>Compensates original movement: {event.originalMovementId}</p>}
          {(event.lines || []).map((line, lineIndex) => <p key={`${line.catalogProductId}:${lineIndex}`}>{line.catalogProductName} · {formatInventoryQuantity(line.quantity)} {line.baseUnit}</p>)}
          {(event.coverageGaps || []).map((gap, gapIndex) => <p key={gapIndex}>Missing evidence: {gap.reason}{gap.supplierProductId ? ` (supplier product ${gap.supplierProductId})` : ""}</p>)}
          {event.orderId && canReadOrders && <a target="_blank" rel="noopener noreferrer" className="mt-2 block underline" href={`/orders/${encodeURIComponent(event.orderId)}`}>{canReceive || canReverseReceipt ? "Review receipt and correction options" : "Review source order"}</a>}
          {event.adjustmentId && canReadMovements && <a target="_blank" rel="noopener noreferrer" className="mt-2 block underline" href={`/catalog/inventory-movements?hotelUid=${encodeURIComponent(hotelUid)}&eventId=${encodeURIComponent(event.adjustmentId)}`}>{canReverseMovements ? "Review movement and reversal" : "Review source movement"}</a>}
          {event.stockCountId && canReadCounts && <a target="_blank" rel="noopener noreferrer" className="mt-2 block underline" href={countUrl(event.stockCountId)}>Review overlapping count</a>}
        </li>)}</ul>
      </details>}
    </li>)}</ul>
    <div className="flex flex-wrap gap-3 border-t border-amber-200 pt-3">
      {canCreateCounts && <a target="_blank" rel="noopener noreferrer" className="ht-button-secondary" href={`/catalog/stock-counts/new?${recountQuery}`}>Start a follow-up count</a>}
      {canReadMovements && <a target="_blank" rel="noopener noreferrer" className="ht-button-secondary" href="/catalog/inventory-movements">{canReverseMovements || canCreateMovements ? "Review or correct movements" : "Review movement history"}</a>}
    </div>
    <p className="text-xs">Review and follow-up links open in a new tab to keep your current draft. Save your edits in the original tab before closing it.</p>
    <p className="text-xs">Receipt corrections require the existing receiving or receiving-supervisor permission. Movement reversals require an Inventory Supervisor; new movements and counts require their existing create permissions. Keep the original event or count reference in the correction reason.</p>
  </section>;
}
