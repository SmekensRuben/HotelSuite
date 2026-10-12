import React, { useEffect, useState } from "react";
import { getPendingProductCommand, retryPendingProductCommand } from "../../services/firebaseProducts";

export default function PendingProductCommand({ hotelUid, collection, productId, onComplete }) {
  const [pending, setPending] = useState(() => getPendingProductCommand(hotelUid, collection, productId));
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const refresh = () => setPending(getPendingProductCommand(hotelUid, collection, productId));
    refresh();
    window.addEventListener("product-command-changed", refresh);
    return () => window.removeEventListener("product-command-changed", refresh);
  }, [hotelUid, collection, productId]);
  if (!pending) return null;
  return <div className="rounded border border-amber-300 bg-amber-50 p-4 space-y-2">
    <p className="font-semibold">A saved product request needs reconciliation</p>
    <p className="text-sm">The outcome of the previous {pending.action} request for {pending.product?.name || pending.product?.supplierProductName || productId || "this product"} is still unknown. Retry the saved request before changing values. This uses the original request ID and values.</p>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <button type="button" disabled={retrying} className="rounded border border-amber-500 px-3 py-2 text-sm font-semibold disabled:opacity-60" onClick={async () => {
      setRetrying(true); setError("");
      try { const result = await retryPendingProductCommand(hotelUid, collection, productId); onComplete?.(result); }
      catch (failure) { setError(failure?.message || "Could not reconcile the saved request."); }
      finally { setRetrying(false); }
    }}>{retrying ? "Retrying saved request…" : "Retry saved request"}</button>
  </div>;
}
