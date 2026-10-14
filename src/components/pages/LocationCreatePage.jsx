import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { usePermission } from "../../hooks/usePermission";
import { useProcurementSettingsScope } from "../../hooks/useProcurementSettingsScope";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { createLocation, getLocationOutletChoices } from "../../services/firebaseSettings";
import PendingProcurementResourceMutation, { usePendingProcurementResourceMutation } from "../inventory/PendingProcurementResourceMutation";

export default function LocationCreatePage() {
  const navigate = useNavigate();
  const { hotelUid, scopeKey, current } = useProcurementSettingsScope();
  const canCreate = usePermission("locations", "create");
  const recovery = usePendingProcurementResourceMutation({ hotelUid, collection: "locations", resourceId: "new", onComplete: (result) => navigate(`/settings/locations/${result.resourceId}`) });
  const [name, setName] = useState(""),
    [outletId, setOutletId] = useState(""),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const active = useRef({ scopeKey });
  if (active.current.scopeKey !== scopeKey) active.current = { scopeKey };
  const loadOutlets = useCallback(async () => {
    const outlets = await getLocationOutletChoices(hotelUid, "create");
    if (!current()) throw new Error("Hotel access changed. Reload locations.");
    return outlets.filter((outlet) => outlet.archived !== true && outlet.active !== false && !outlet.archivedAt);
  }, [hotelUid, current]);
  const outlets = useScopedAsync({ scopeKey, enabled: Boolean(hotelUid && canCreate), load: loadOutlets });
  useEffect(() => {
    active.current = { scopeKey };
    setName("");
    setOutletId("");
    setSaving(false);
    setError("");
    return () => {
      active.current = { scopeKey: null };
    };
  }, [scopeKey]);
  const submit = async (event) => {
    event.preventDefault();
    if (!canCreate || !hotelUid || !name.trim() || saving || recovery.blocked || !current() ||
      !outlets.data?.some((outlet) => outlet.id === outletId)) return;
    const requested = active.current;
    setSaving(true);
    setError("");
    try {
      await createLocation(hotelUid, {
        name: name.trim(),
        outletId,
        createdBy: auth.currentUser?.uid || null,
      });
      if (active.current === requested && current()) navigate("/settings/locations");
    } catch (failure) {
      if (active.current === requested && current()) {
        setError(failure.message || "Unable to save the location.");
        recovery.refresh();
      }
    } finally {
      if (active.current === requested && current()) setSaving(false);
    }
  };
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
          <h1 className="mt-1 text-3xl font-semibold">Add Location</h1>
          <p className="mt-2 text-sm text-gray-600">
            Locations add optional detail inside an outlet, such as a cold room
            or bar fridge. You can count an outlet directly without any locations.
          </p>
        </div>
        <PendingProcurementResourceMutation recovery={recovery} noun="location" disabled={saving} />
        <Card>
          <form onSubmit={submit} className="space-y-5">
            <div>
              <label htmlFor="location-outlet" className="mb-2 block text-sm font-medium text-gray-700">Outlet</label>
              <select id="location-outlet" value={outletId} onChange={(event) => setOutletId(event.target.value)}
                disabled={saving || recovery.blocked || !canCreate || outlets.loading || Boolean(outlets.error)} required
                className="min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                <option value="">{outlets.loading ? "Loading outlets..." : "Choose an outlet"}</option>
                {(outlets.data || []).map((outlet) => <option key={outlet.id} value={outlet.id}>{outlet.name}{outlet.inventoryRole === "central_storage" ? " · Central stock point" : ""}</option>)}
              </select>
              <p className="mt-2 text-sm text-gray-500">Use a central stock point for stock distributed to other outlets.</p>
              {outlets.error && <div role="alert" className="mt-2 text-sm text-red-700">
                <p>{outlets.error.message || "Unable to load outlets."}</p>
                <button type="button" onClick={outlets.retry} className="mt-1 underline">Retry outlets</button>
              </div>}
              {!outlets.loading && !outlets.error && outlets.data?.length === 0 && <p className="mt-2 text-sm text-amber-800">Create an outlet before adding its optional locations.</p>}
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
                disabled={saving || recovery.blocked || !canCreate}
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
                onClick={() => navigate("/settings/locations")}
                className="min-h-11 rounded-lg border border-gray-300 px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canCreate || !hotelUid || saving || recovery.blocked || !name.trim() || !outlets.data?.some((outlet) => outlet.id === outletId)}
                className="min-h-11 rounded-lg bg-brand-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save Location"}
              </button>
            </div>
          </form>
        </Card>
      </ProcurementPage>
    </div>
  );
}
