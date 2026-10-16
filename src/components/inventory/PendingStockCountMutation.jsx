import React, { useCallback, useEffect, useRef, useState } from "react";
import { getPendingStockCountMutation, retryPendingStockCountMutation } from "../../services/firebaseStockCounts";
import { auth } from "../../firebaseConfig";

// An uncertain command must be retried with its original identity, including
// after navigation, a closed tab or a lost acknowledgement from the server.
export default function PendingStockCountMutation({ hotelUid, stockCountId, locationId = null, disabled = false, onComplete, onPendingChange }) {
  const [pending, setPending] = useState(null);
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const actor = auth.currentUser;
  const scope = JSON.stringify([actor?.uid, hotelUid, stockCountId, locationId]);
  const currentScope = useRef({ scope, actor });
  if (currentScope.current.scope !== scope || currentScope.current.actor !== actor) currentScope.current = { scope, actor };
  const changeHandler = useRef(onPendingChange);
  changeHandler.current = onPendingChange;
  const refresh = useCallback(() => {
    if (auth.currentUser !== actor || currentScope.current.scope !== scope) return;
    try {
      const next = getPendingStockCountMutation(hotelUid, stockCountId, locationId);
      setPending(next);
      changeHandler.current?.(Boolean(next));
    } catch (readError) {
      setError(readError.message);
      changeHandler.current?.(true);
    }
  }, [hotelUid, stockCountId, locationId, actor, scope]);
  useEffect(() => {
    const active = { scope, actor };
    currentScope.current = active;
    setError(""); setRetrying(false); setPending(null);
    refresh();
    window.addEventListener("stock-count-command-changed", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      if (currentScope.current === active) currentScope.current = { scope: null, actor: null };
      window.removeEventListener("stock-count-command-changed", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [refresh, scope, actor]);

  const retry = async () => {
    if (auth.currentUser !== actor || currentScope.current.actor !== actor) return;
    const originalScope = currentScope.current;
    const isActive = () => currentScope.current === originalScope && auth.currentUser === originalScope.actor;
    setRetrying(true); setError("");
    try {
      const result = await retryPendingStockCountMutation(hotelUid, stockCountId, locationId);
      if (!isActive()) return;
      refresh();
      await onComplete?.(result, pending);
    } catch (retryError) {
      if (isActive()) { setError(retryError.message || "Unable to confirm the saved change. Please retry."); refresh(); }
    } finally {
      if (isActive()) setRetrying(false);
    }
  };
  if (!pending && !error) return null;
  return <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" role="status">
    {pending && <>
      <p>A saved change is awaiting confirmation. Retry it to find out whether it was saved before making another change.</p>
      <button type="button" disabled={disabled || retrying} onClick={retry}
        className="rounded border border-amber-400 bg-white px-3 py-2 font-medium disabled:opacity-50">
        {retrying ? "Confirming saved change..." : "Retry saved change"}
      </button>
    </>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
