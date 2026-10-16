import React, { useCallback } from "react";
import { usePermission } from "../../hooks/usePermission";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { getStockCountExceptions } from "../../services/firebaseInventory";
import { procurementReadScope } from "../../services/procurementReadPool";
import InventoryExceptionReview from "./InventoryExceptionReview";

export default function StockCountExceptionReview({ hotelUid, stockCountId, locationId, revision }) {
  const canRead = usePermission("stockcounts", "read");
  const scope = procurementReadScope(hotelUid)?.key;
  const load = useCallback(() => getStockCountExceptions(hotelUid, stockCountId, locationId), [hotelUid, stockCountId, locationId]);
  const review = useScopedAsync({ scopeKey: `${scope}:${stockCountId}:${locationId}:${revision}:${canRead}`, enabled: Boolean(hotelUid && stockCountId && locationId && canRead), load });
  if (!canRead) return null;
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium">Physical counting cutoff</p><button type="button" className="ht-button-secondary" disabled={review.loading} onClick={review.retry}>Refresh count events</button></div>
    {review.loading && <p role="status" className="text-sm">Checking recorded events…</p>}
    {review.error && <p role="alert" className="text-sm text-amber-900">Count events could not be verified: {review.error.message} Saving quantities does not establish a reliable cutoff. Retry or ask an inventory supervisor to review the source records.</p>}
    {review.data && <>
      <p className="text-xs text-slate-600">Checked through posting #{review.data.checkedThroughSequence} at {new Date(review.data.checkedAtMillis).toLocaleString("en-GB")}. New postings can arrive after this check; finishing checks the cutoff again.</p>
      {!review.data.issues.length && <p className="text-sm">No recorded movement exceptions at this check. Coordinate deliveries and movements until counting is finished.</p>}
      <InventoryExceptionReview issues={review.data.issues} hotelUid={hotelUid} locationId={locationId} stockCountId={stockCountId} />
    </>}
  </div>;
}
