import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { usePermission } from "../../hooks/usePermission";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import {
  getLocationById,
  updateLocation,
} from "../../services/firebaseSettings";

export default function LocationEditPage() {
  const navigate = useNavigate(),
    { locationId } = useParams(),
    { hotelUid } = useHotelContext();
  const canUpdate = usePermission("locations", "update"),
    scopeKey = `${hotelUid}:${locationId}`;
  const [name, setName] = useState(""),
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
  useEffect(() => {
    active.current = { key: scopeKey };
    setName("");
    setSaving(false);
    setError("");
    return () => {
      active.current = { key: null };
    };
  }, [scopeKey]);
  useEffect(() => {
    if (query.data) setName(query.data.name || "");
  }, [query.data]);
  const submit = async (event) => {
    event.preventDefault();
    if (
      !canUpdate ||
      !hotelUid ||
      !locationId ||
      !name.trim() ||
      saving ||
      !query.data ||
      query.data.archived === true
    )
      return;
    const requested = active.current;
    setSaving(true);
    setError("");
    try {
      await updateLocation(hotelUid, locationId, {
        name: name.trim(),
        updatedBy: auth.currentUser?.uid || null,
      });
      if (active.current === requested)
        navigate(`/settings/locations/${locationId}`);
    } catch (failure) {
      if (active.current === requested)
        setError(failure.message || "Unable to save the location.");
    } finally {
      if (active.current === requested) setSaving(false);
    }
  };
  const disabled =
    !canUpdate ||
    saving ||
    query.loading ||
    Boolean(query.error) ||
    !query.data ||
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
        </div>
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
              {query.data.archived === true && (
                <p className="text-sm text-amber-800">
                  This location is archived and cannot be edited.
                </p>
              )}
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
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
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
                  className="rounded-lg border border-gray-300 px-4 py-2 text-sm"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={disabled || !name.trim()}
                  className="rounded-lg bg-brand-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
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
