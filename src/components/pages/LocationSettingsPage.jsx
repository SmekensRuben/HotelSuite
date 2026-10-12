import React, { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getLocations } from "../../services/firebaseSettings";
import { usePermission } from "../../hooks/usePermission";
import { useScopedAsync } from "../../hooks/useScopedAsync";

export default function LocationSettingsPage() {
  const navigate = useNavigate(),
    { hotelUid } = useHotelContext();
  const canCreate = usePermission("locations", "create");
  const [search, setSearch] = useState(""),
    [includeArchived, setIncludeArchived] = useState(false);
  const load = useCallback(
    () => getLocations(hotelUid, { includeArchived: true }),
    [hotelUid],
  );
  const query = useScopedAsync({
    scopeKey: hotelUid,
    enabled: Boolean(hotelUid),
    load,
  });
  const rows = useMemo(
    () =>
      (query.data || []).filter(
        (item) =>
          (includeArchived || item.archived !== true) &&
          String(item.name || "")
            .toLowerCase()
            .includes(search.trim().toLowerCase()),
      ),
    [query.data, search, includeArchived],
  );
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
      <ProcurementPage className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">
              Purchasing &amp; Inventory · Settings
            </p>
            <h1 className="mt-1 text-3xl font-semibold">Location Settings</h1>
            <p className="mt-2 max-w-xl text-sm text-gray-600">
              Manage physical storage and counting locations. Archive unused
              locations to remove them from new workflows while keeping
              historical references.
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate("/settings/locations/new")}
            disabled={!canCreate}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            Add Location
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-4 rounded-xl border border-gray-200 bg-white p-3">
          <div className="min-w-0 flex-1 sm:max-w-md">
            <label htmlFor="locations-search" className="sr-only">
              Search locations
            </label>
            <input
              id="locations-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by location name"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(event) => setIncludeArchived(event.target.checked)}
            />
            Show archived
          </label>
        </div>
        {query.loading ? (
          <p className="text-sm text-gray-600">Loading locations...</p>
        ) : query.error ? (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
          >
            <p>{query.error.message || "Unable to load locations."}</p>
            <button
              type="button"
              className="mt-2 underline"
              onClick={query.retry}
            >
              Retry locations
            </button>
          </div>
        ) : (
          <DataListTable
            columns={[
              { key: "name", label: "Name" },
              {
                key: "archived",
                label: "Status",
                render: (item) => (
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs ${item.archived === true ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-800"}`}
                  >
                    {item.archived === true ? "Archived" : "Active"}
                  </span>
                ),
              },
            ]}
            rows={rows}
            emptyMessage="No locations found."
            onRowClick={(row) => navigate(`/settings/locations/${row.id}`)}
          />
        )}
      </ProcurementPage>
    </div>
  );
}
