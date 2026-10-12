import React, { useEffect, useRef, useState } from "react";
import { getPendingCountCreation, retryPendingCountCreation } from "../../services/firebaseStockCounts";
import { getPendingStockTemplateCommand, retryPendingStockTemplateCommand } from "../../services/firebaseSettings";

export default function PendingStockCommand({ kind = "template", hotelUid, locationId, templateId, disabled = false, onComplete }) {
  const scopeKey = `${kind}:${hotelUid}:${locationId || ""}:${templateId || "create"}`;
  const active = useRef({ key: scopeKey }); if (active.current.key !== scopeKey) active.current = { key: scopeKey };
  const [state, setState] = useState({ scopeKey: null, pending: null, storageError: "" });
  const [retrying, setRetrying] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    active.current = { key: scopeKey }; setRetrying(false); setError("");
    const refresh = () => {
      try { const pending = kind === "count" ? getPendingCountCreation(hotelUid) : getPendingStockTemplateCommand(hotelUid, locationId, templateId); setState({ scopeKey, pending, storageError: "" }); }
      catch (failure) { setState({ scopeKey, pending: null, storageError: failure.message }); }
    };
    const eventName = kind === "count" ? "stock-count-command-changed" : "stock-template-command-changed";
    refresh(); window.addEventListener(eventName, refresh);
    return () => { active.current = { key: null }; window.removeEventListener(eventName, refresh); };
  }, [scopeKey, kind, hotelUid, locationId, templateId]);
  const current = state.scopeKey === scopeKey ? state : { pending: null, storageError: "" };
  if (!current.pending && !current.storageError) return null;
  return <div className="space-y-2 rounded border border-amber-300 bg-amber-50 p-4">
    <p className="font-semibold">A saved {kind === "count" ? "stock count creation" : "template command"} needs reconciliation</p>
    {current.storageError ? <p role="alert">{current.storageError}</p> : <>
      <p className="text-sm">The previous {current.pending.action || "create"} request{current.pending.name ? ` for ${current.pending.name}` : ""} has an unconfirmed outcome. Retry its original saved values and request ID before making another change.</p>
      {error && <p role="alert" className="text-red-700">{error}</p>}
      <button type="button" disabled={disabled || retrying} className="rounded border border-amber-500 px-3 py-2 text-sm font-semibold disabled:opacity-50" onClick={async () => {
        const requested = active.current; setRetrying(true); setError("");
        try {
          const result = kind === "count" ? await retryPendingCountCreation(hotelUid) : await retryPendingStockTemplateCommand(hotelUid, locationId, templateId);
          if (active.current === requested) await onComplete?.(result);
        } catch (failure) { if (active.current === requested) setError(failure.message || "Unable to reconcile the saved request."); }
        finally { if (active.current === requested) setRetrying(false); }
      }}>{retrying ? "Retrying saved request..." : "Retry saved request"}</button>
    </>}
  </div>;
}
