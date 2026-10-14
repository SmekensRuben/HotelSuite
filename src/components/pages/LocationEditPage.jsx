import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { usePermission } from "../../hooks/usePermission";
import { useProcurementSettingsScope } from "../../hooks/useProcurementSettingsScope";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import {
  getLocationById,
  getLocationOutletChoices,
  updateLocation,
} from "../../services/firebaseSettings";
import PendingProcurementResourceMutation, { usePendingProcurementResourceMutation } from "../inventory/PendingProcurementResourceMutation";

export default function LocationEditPage() {
  const navigate = useNavigate(),
    { locationId } = useParams();
  const scope = useProcurementSettingsScope();
  const { hotelUid, current } = scope;
  const recovery = usePendingProcurementResourceMutation({ hotelUid, collection: "locations", resourceId: locationId, onComplete: () => navigate(`/settings/locations/${locationId}`) });
  const canUpdate = usePermission("locations", "update"),
    scopeKey = `${scope.scopeKey}:${locationId}`;
  const [name, setName] = useState(""),
    [outletId, setOutletId] = useState(""),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const active = useRef({ key: scopeKey });
  if (active.current.key !== scopeKey) active.current = { key: scopeKey };
  const load = useCallback(
    () => getLocationById(hotelUid, locationId),
    [hotelUid, locationId],
  );
  const query = useScopedAsync({
    scopeKey,
    enabled: Boolean(hotelUid && locationId),
    load,
  });
  const isOutletStockPoint = query.data?.stockPointType === "outlet" || String(locationId || "").startsWith("outlet:");
  const loadOutlets = useCallback(async () => {
    const outlets = await getLocationOutletChoices(hotelUid, "update");
    if (!current()) throw new Error("Hotel access changed. Reload locations.");
    return outlets.filter((outlet) => outlet.archived !== true && outlet.active !== false && !outlet.archivedAt);
  }, [hotelUid, current]);
  const outlets = useScopedAsync({ scopeKey, enabled: Boolean(hotelUid && canUpdate && query.data && query.data.archived !== true && !isOutletStockPoint), load: loadOutlets });
  useEffect(() => {
    active.current = { key: scopeKey };
    setName("");
    setOutletId("");
    setSaving(false);
    setError("");
    return () => {
      active.current = { key: null };
    };
  }, [scopeKey]);
  useEffect(() => {
    if (query.data) {
      setName(query.data.name || "");
      setOutletId(query.data.outletId || "");
    }
  }, [query.data]);
  const submit = async (event) => {
    event.preventDefault();
    if (
      !canUpdate ||
      !hotelUid ||
      !locationId ||
      !name.trim() ||
      saving ||
      recovery.blocked ||
      !query.data ||
      isOutletStockPoint ||
      !current() ||
      (outletId !== (query.data.outletId || "") && outletId && !outlets.data?.some((outlet) => outlet.id === outletId)) ||
      query.data.archived === true
    )
      return;
    const requested = active.current;
    setSaving(true);
    setError("");
    try {
      await updateLocation(hotelUid, locationId, {
        name: name.trim(),
        expectedRevision: query.data.revision ?? 0,
        ...(outletId !== (query.data.outletId || "") ? { outletId: outletId || null } : {}),
        updatedBy: auth.currentUser?.uid || null,
      });
      if (active.current === requested && current())
        navigate(`/settings/locations/${locationId}`);
    } catch (failure) {
      if (active.current === requested && current()) {
        setError(failure.message || "Unable to save the location.");
        recovery.refresh();
      }
    } finally {
      if (active.current === requested && current()) setSaving(false);
    }
  };
  const disabled =
    !canUpdate ||
    saving ||
    recovery.blocked ||
    query.loading ||
    Boolean(query.error) ||
    !query.data ||
    isOutletStockPoint ||
    query.data.archived === true;
  return (
    <div className="min-h-screen bg-canvas text-gray-900">
      <HeaderBar
        today={new Date().toLocaleDateString()}
        onLogout={async () => {
          await signOut(auth);
          sessionStorage.clear();
          window.location.href = "/login";
        }}
      />
      <ProcurementPage width="form" className="space-y-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">
            Purchasing &amp; Inventory · Settings
          </p>
          <h1 className="mt-1 text-3xl font-semibold">Edit Location</h1>
          <p className="mt-2 text-sm text-gray-600">Locations add optional detail inside an outlet. Count the whole outlet directly when you do not need this detail.</p>
        </div>
        <PendingProcurementResourceMutation recovery={recovery} noun="location" disabled={saving} />
        {query.loading ? (
          <p>Loading location...</p>
        ) : query.error ? (
          <div role="alert">
            <p>{query.error.message || "Unable to load location."}</p>
            <button type="button" onClick={query.retry} className="underline">
              Retry location
            </button>
          </div>
        ) : !query.data ? (
          <Card>Location not found.</Card>
        ) : (
          <Card>
            <form onSubmit={submit} className="space-y-5">
              {isOutletStockPoint && <p role="status" className="rounded-lg bg-brand-50 p-3 text-sm text-brand-900">This stock point represents the whole outlet. Manage its name and status in Outlet settings.</p>}
              {query.data.archived === true && (
                <p className="text-sm text-amber-800">
                  This location is archived and cannot be edited.
                </p>
              )}
              <div>
                <label htmlFor="location-outlet" className="mb-2 block text-sm font-medium text-gray-700">Outlet</label>
                <select id="location-outlet" value={outletId} onChange={(event) => setOutletId(event.target.value)}
                  disabled={disabled || outlets.loading || Boolean(outlets.error)}
                  className="min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                  <option value="">Unassigned location</option>
                  {query.data.outletId && !outlets.data?.some((outlet) => outlet.id === query.data.outletId) &&
                    <option value={query.data.outletId}>Current outlet (unavailable)</option>}
                  {(outlets.data || []).map((outlet) => <option key={outlet.id} value={outlet.id}>{outlet.name}{outlet.inventoryRole === "central_storage" ? " · Central stock point" : ""}</option>)}
                </select>
                <p className="mt-2 text-sm text-gray-500">Existing unassigned locations remain available. Link them to an outlet when you are ready.</p>
                {outlets.error && <div role="alert" className="mt-2 text-sm text-red-700">
                  <p>{outlets.error.message || "Unable to load outlets."}</p>
                  <button type="button" onClick={outlets.retry} className="mt-1 underline">Retry outlets</button>
                </div>}
              </div>
              <div>
                <label
                  htmlFor="location-name"
                  className="mb-2 block text-sm font-medium text-gray-700"
                >
                  Name
                </label>
                <input
                  id="location-name"
                  maxLength={200}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={disabled}
                  placeholder="Location name"
                  className="min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  required
                />
              </div>
              {error && (
                <p role="alert" className="text-sm text-red-700">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-2 border-t border-gray-100 pt-4">
                <button
                  type="button"
                  onClick={() => navigate(`/settings/locations/${locationId}`)}
                  className="min-h-11 rounded-lg border border-gray-300 px-4 py-2 text-sm"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={disabled || !name.trim() || (outletId !== (query.data.outletId || "") && outletId && !outlets.data?.some((outlet) => outlet.id === outletId))}
                  className="min-h-11 rounded-lg bg-brand-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {saving ? "Saving..." : "Save Location"}
                </button>
              </div>
            </form>
          </Card>
        )}
      </ProcurementPage>
    </div>
  );
}
