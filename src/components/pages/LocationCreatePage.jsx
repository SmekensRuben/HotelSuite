import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { usePermission } from "../../hooks/usePermission";
import { createLocation } from "../../services/firebaseSettings";

export default function LocationCreatePage() {
  const navigate = useNavigate(),
    { hotelUid } = useHotelContext();
  const canCreate = usePermission("locations", "create");
  const [name, setName] = useState(""),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const active = useRef({ hotelUid });
  if (active.current.hotelUid !== hotelUid) active.current = { hotelUid };
  useEffect(() => {
    active.current = { hotelUid };
    setName("");
    setSaving(false);
    setError("");
    return () => {
      active.current = { hotelUid: null };
    };
  }, [hotelUid]);
  const submit = async (event) => {
    event.preventDefault();
    if (!canCreate || !hotelUid || !name.trim() || saving) return;
    const requested = active.current;
    setSaving(true);
    setError("");
    try {
      await createLocation(hotelUid, {
        name: name.trim(),
        createdBy: auth.currentUser?.uid || null,
      });
      if (active.current === requested) navigate("/settings/locations");
    } catch (failure) {
      if (active.current === requested)
        setError(failure.message || "Unable to save the location.");
    } finally {
      if (active.current === requested) setSaving(false);
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
            Create a physical storage or counting area, such as a cold room or
            beverage store.
          </p>
        </div>
        <Card>
          <form onSubmit={submit} className="space-y-5">
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
                disabled={saving || !canCreate}
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
                onClick={() => navigate("/settings/locations")}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canCreate || !hotelUid || saving || !name.trim()}
                className="rounded-lg bg-brand-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
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
