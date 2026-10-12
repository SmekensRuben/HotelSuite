import React, { useEffect, useRef, useState } from "react";
import { usePermission } from "../../hooks/usePermission";
import {
  archiveLocation,
  archiveOutlet,
  getPendingProcurementResourceCommand,
  retryPendingProcurementResourceCommand,
} from "../../services/firebaseSettings";

/** Archival keeps stable references for existing orders, counts and templates. */
export default function ProcurementResourceArchive({
  hotelUid,
  collection,
  resource,
  onArchived,
}) {
  const canArchive = usePermission(collection, "delete");
  const scopeKey = `${hotelUid}:${collection}:${resource?.id}`;
  const active = useRef({ key: scopeKey });
  if (active.current.key !== scopeKey) active.current = { key: scopeKey };
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [pending, setPending] = useState(null),
    [storageError, setStorageError] = useState(false);
  useEffect(() => {
    active.current = { key: scopeKey };
    setBusy(false);
    setError("");
    setStorageError(false);
    try {
      setPending(
        getPendingProcurementResourceCommand(
          hotelUid,
          collection,
          resource?.id,
        ),
      );
    } catch (failure) {
      setPending(null);
      setStorageError(true);
      setError(failure.message || "The saved archive request is unavailable.");
    }
    return () => {
      active.current = { key: null };
    };
  }, [hotelUid, collection, resource?.id, scopeKey]);
  if (!resource) return null;
  const noun = collection === "locations" ? "location" : "outlet";
  const run = async (retry = false) => {
    if (
      !canArchive ||
      busy ||
      storageError ||
      (resource.archived === true && !retry)
    )
      return;
    if (
      !retry &&
      !window.confirm(
        `Archive ${resource.name || `this ${noun}`}? It will no longer be offered for new workflows. Existing orders, stock counts and historical references are preserved.`,
      )
    )
      return;
    const requested = active.current;
    setBusy(true);
    setError("");
    try {
      if (retry)
        await retryPendingProcurementResourceCommand(
          hotelUid,
          collection,
          resource.id,
        );
      else
        await (collection === "locations" ? archiveLocation : archiveOutlet)(
          hotelUid,
          resource.id,
          resource.revision ?? 0,
        );
      if (active.current !== requested) return;
      setPending(null);
      onArchived();
    } catch (failure) {
      if (active.current === requested) {
        setError(failure.message || `Unable to archive the ${noun}.`);
        try {
          setPending(
            getPendingProcurementResourceCommand(
              hotelUid,
              collection,
              resource.id,
            ),
          );
        } catch (savedFailure) {
          setStorageError(true);
          setError(
            savedFailure.message || "The saved archive request is unavailable.",
          );
        }
      }
    } finally {
      if (active.current === requested) setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      {resource.archived === true && (
        <p
          role="status"
          className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
        >
          Archived {noun}. Historical records remain available; new workflows
          cannot use it.
        </p>
      )}
      {canArchive && (resource.archived !== true || pending) && (
        <button
          type="button"
          disabled={busy || storageError}
          onClick={() => run(Boolean(pending))}
          className="rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
        >
          {busy
            ? "Archiving..."
            : pending
              ? "Retry original archive request"
              : `Archive ${noun}`}
        </button>
      )}
      {pending && (
        <p className="text-xs text-amber-800">
          An archive request has an unconfirmed result. Retry its original
          request to resolve it.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
