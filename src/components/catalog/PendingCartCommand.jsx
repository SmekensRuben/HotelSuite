import React, { useEffect, useRef, useState } from "react";
import { getPendingCartCommand, retryPendingCartCommand } from "../../services/firebaseShoppingCarts";
import { auth } from "../../firebaseConfig";

export default function PendingCartCommand({ hotelUid, cartId = "active", onComplete, inFlight = false, onPendingChange }) {
  const [pending, setPending] = useState(null);
  const [storageError, setStorageError] = useState("");
  const actor = useRef(auth.currentUser).current, mounted = useRef(false), retryLock = useRef(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    mounted.current = true;
    const refresh = () => {
      if (auth.currentUser !== actor) return;
      try { setPending(getPendingCartCommand(hotelUid, cartId)); setStorageError(""); }
      catch (failure) { setStorageError(failure?.message || "The saved cart request could not be read."); }
    };
    refresh(); window.addEventListener("cart-command-changed", refresh);
    return () => { mounted.current = false; window.removeEventListener("cart-command-changed", refresh); };
  }, [hotelUid, cartId, actor]);
  useEffect(() => { onPendingChange?.(Boolean(pending || storageError)); }, [pending, storageError, onPendingChange]);
  if (inFlight || (!pending && !storageError)) return null;
  return <div className="rounded border border-amber-300 bg-amber-50 p-4 space-y-2">
    <p className="font-semibold">A saved cart request needs reconciliation</p>
    {storageError ? <p role="alert" className="text-sm text-red-700">{storageError} Keep this saved request for operator review; replacement cart changes are blocked.</p> : <p className="text-sm">The previous {pending.action} request has an unknown result. Retry its original values and revision before making another cart change.</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <button type="button" disabled={retrying || Boolean(storageError)} className="rounded border border-amber-500 px-3 py-2 text-sm font-semibold disabled:opacity-60" onClick={async () => {
      if (retryLock.current || auth.currentUser !== actor) return;
      retryLock.current = true;
      setRetrying(true); setError("");
      try { const result = await retryPendingCartCommand(hotelUid, cartId); if (mounted.current && auth.currentUser === actor) await onComplete?.(result); }
      catch (failure) { if (mounted.current && auth.currentUser === actor) setError(failure?.message || "Could not reconcile the saved cart request."); }
      finally { retryLock.current = false; if (mounted.current && auth.currentUser === actor) setRetrying(false); }
    }}>{retrying ? "Retrying saved cart request…" : "Retry saved cart request"}</button>
  </div>;
}
