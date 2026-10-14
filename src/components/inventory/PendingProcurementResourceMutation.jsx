import React, { useCallback, useEffect, useRef, useState } from "react";
import { auth } from "../../firebaseConfig";
import { useProcurementSettingsScope } from "../../hooks/useProcurementSettingsScope";
import { usePermission } from "../../hooks/usePermission";
import { getPendingProcurementResourceCommand, retryPendingProcurementResourceCommand } from "../../services/firebaseSettings";

export function usePendingProcurementResourceMutation({ hotelUid, collection, resourceId = "new", onComplete }) {
  const scope = useProcurementSettingsScope();
  const scopeKey = `${scope.scopeKey}:${collection}:${resourceId}`;
  const active = useRef(scopeKey);
  active.current = scopeKey;
  const [state, setState] = useState({ scopeKey: null, pending: null, error: "", storageError: false, busy: false });
  const currentState = state.scopeKey === scopeKey ? state : { pending: null, error: "", storageError: false, busy: false };
  const canRetry = usePermission(collection, currentState.pending?.action === "archive" ? "delete" : currentState.pending?.action || (resourceId === "new" ? "create" : "update"));
  const refresh = useCallback(() => {
    if (!scope.current() || active.current !== scopeKey) return;
    try {
      const pending = getPendingProcurementResourceCommand(hotelUid, collection, resourceId);
      setState((previous) => ({ ...previous, scopeKey, pending, storageError: false }));
    } catch (error) {
      setState((previous) => ({ ...previous, scopeKey, pending: null, storageError: true, error: error.message || "The saved resource request cannot be read. Review its outcome before continuing." }));
    }
  }, [hotelUid, collection, resourceId, scopeKey, scope.current]);
  useEffect(() => {
    active.current = scopeKey;
    setState({ scopeKey, pending: null, error: "", storageError: false, busy: false });
    refresh();
    return () => { if (active.current === scopeKey) active.current = null; };
  }, [scopeKey, refresh]);
  const retry = async () => {
    if (!canRetry || currentState.busy || !currentState.pending || !scope.current()) return;
    const actor = auth.currentUser;
    const pending = currentState.pending;
    setState((previous) => ({ ...previous, busy: true, error: "" }));
    try {
      const result = await retryPendingProcurementResourceCommand(hotelUid, collection, resourceId);
      if (!scope.current() || auth.currentUser !== actor || active.current !== scopeKey) return;
      setState({ scopeKey, pending: null, error: "", storageError: false, busy: false });
      await onComplete?.(result, pending);
    } catch (error) {
      if (!scope.current() || auth.currentUser !== actor || active.current !== scopeKey) return;
      setState((previous) => ({ ...previous, busy: false, error: error.message || "Unable to confirm the saved resource request." }));
      refresh();
    }
  };
  return { ...currentState, canRetry, retry, refresh, blocked: Boolean(currentState.pending || currentState.storageError || currentState.busy) };
}

export default function PendingProcurementResourceMutation({ recovery, noun, disabled = false }) {
  if (!recovery.pending && !recovery.error) return null;
  return <div role="alert" className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
    {recovery.pending && <>
      <p className="font-semibold">A saved {noun} request needs confirmation</p>
      <p>The original {recovery.pending.action} request and its settings are preserved. Confirm its outcome before changing this {noun}.</p>
      {recovery.pending.resource?.name && <p>Saved {noun}: <span className="font-medium">{recovery.pending.resource.name}</span></p>}
      <button type="button" className="ht-button-secondary" disabled={disabled || recovery.busy || !recovery.canRetry} onClick={recovery.retry}>{recovery.busy ? "Confirming saved request…" : `Retry saved ${noun} request`}</button>
      {!recovery.canRetry && <p>Your current permissions do not allow retrying this saved action.</p>}
    </>}
    {recovery.error && <p>{recovery.error}</p>}
  </div>;
}
