import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getLocations } from "../../services/firebaseSettings";
import { usePermission } from "../../hooks/usePermission";

export default function LocationSettingsPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const canCreateLocations = usePermission("locations", "create");
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);

  const today = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);

  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  useEffect(() => {
    const loadLocations = async () => {
      if (!hotelUid) return;
      setLoading(true);
      const result = await getLocations(hotelUid);
      setLocations(result);
      setLoading(false);
    };

    loadLocations();
  }, [hotelUid]);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">Settings</p>
            <h1 className="text-3xl font-semibold">Location Settings</h1>
            <p className="text-gray-600 mt-1">Manage locations for this hotel.</p>
          </div>
          <button
            onClick={() => navigate("/settings/locations/new")}
            disabled={!canCreateLocations}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold shadow ${canCreateLocations ? "bg-[#b41f1f] text-white hover:bg-[#961919]" : "bg-gray-300 text-gray-500 cursor-not-allowed"}`}
          >
            <Plus className="h-4 w-4" /> Add Location
          </button>
        </div>

        {loading ? (
          <p className="text-gray-600">Loading locations...</p>
        ) : (
          <DataListTable
            columns={[{ key: "name", label: "Name" }]}
            rows={locations}
            emptyMessage="No locations found."
            onRowClick={(row) => navigate(`/settings/locations/${row.id}`)}
          />
        )}
      </PageContainer>
    </div>
  );
}
