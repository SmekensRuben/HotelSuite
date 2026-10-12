import React, { useEffect, useState } from "react";
import { getPendingCartCommand, retryPendingCartCommand } from "../../services/firebaseShoppingCarts";

export default function PendingCartCommand({ hotelUid, cartId = "active", onComplete }) {
  const [pending, setPending] = useState(() => getPendingCartCommand(hotelUid, cartId));
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const refresh = () => setPending(getPendingCartCommand(hotelUid, cartId));
    refresh(); window.addEventListener("cart-command-changed", refresh);
    return () => window.removeEventListener("cart-command-changed", refresh);
  }, [hotelUid, cartId]);
  if (!pending) return null;
  return <div className="rounded border border-amber-300 bg-amber-50 p-4 space-y-2">
    <p className="font-semibold">A saved cart request needs reconciliation</p>
    <p className="text-sm">The previous {pending.action} request has an unknown result. Retry its original values and revision before making another cart change.</p>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <button type="button" disabled={retrying} className="rounded border border-amber-500 px-3 py-2 text-sm font-semibold disabled:opacity-60" onClick={async () => {
      setRetrying(true); setError("");
      try { const result = await retryPendingCartCommand(hotelUid, cartId); await onComplete?.(result); }
      catch (failure) { setError(failure?.message || "Could not reconcile the saved cart request."); }
      finally { setRetrying(false); }
    }}>{retrying ? "Retrying saved cart request…" : "Retry saved cart request"}</button>
  </div>;
}
