import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Pencil, Plus } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { createLocationStockTemplate, getLocationById, getLocationStockTemplates } from "../../services/firebaseSettings";
import DataListTable from "../shared/DataListTable";
import { usePermission } from "../../hooks/usePermission";

export default function LocationDetailPage() {
  const navigate = useNavigate();
  const { locationId } = useParams();
  const { hotelUid } = useHotelContext();
  const canEditLocations = usePermission("locations", "update");
  const [location, setLocation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [stockTemplates, setStockTemplates] = useState([]);
  const today = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);
  const handleLogout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };


  const handleCreateStockTemplate = async () => {
    const name = window.prompt("Geef een naam voor de stock template");
    if (!name || !name.trim()) return;
    await createLocationStockTemplate(hotelUid, locationId, name);
    setStockTemplates(await getLocationStockTemplates(hotelUid, locationId));
  };

  useEffect(() => {
    const loadLocation = async () => {
      if (!hotelUid || !locationId) return;
      setLoading(true);
      const [locationData, templates] = await Promise.all([
        getLocationById(hotelUid, locationId),
        getLocationStockTemplates(hotelUid, locationId),
      ]);
      setLocation(locationData);
      setStockTemplates(templates);
      setLoading(false);
    };
    loadLocation();
  }, [hotelUid, locationId]);

  return <div className="min-h-screen bg-gray-50 text-gray-900"><HeaderBar today={today} onLogout={handleLogout} /><PageContainer className="space-y-6"><div className="flex items-center justify-between gap-3"><h1 className="text-3xl font-semibold">Location Detail</h1><div className="flex items-center gap-2"><button type="button" onClick={() => navigate("/settings/locations")} className="inline-flex items-center justify-center rounded border border-gray-300 p-2 text-gray-700 hover:bg-gray-100" title="Back to locations"><ArrowLeft className="h-4 w-4" /></button><button type="button" onClick={() => navigate(`/settings/locations/${locationId}/edit`)} disabled={!canEditLocations} className={`inline-flex items-center justify-center rounded border p-2 ${canEditLocations ? "border-gray-300 text-gray-700 hover:bg-gray-100" : "border-gray-200 text-gray-400 cursor-not-allowed"}`} title="Edit location"><Pencil className="h-4 w-4" /></button></div></div>{loading ? <p className="text-gray-600">Loading location...</p> : !location ? <Card><p className="text-gray-600">Location not found.</p></Card> : <Card><h2 className="text-2xl font-semibold">{location.name || "-"}</h2><p className="text-gray-600 mt-1">ID: {location.id || "-"}</p></Card>}

        {!loading && location && (
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-semibold">Stock Templates</h3>
              <button type="button" onClick={handleCreateStockTemplate} className="inline-flex items-center gap-2 rounded border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100">
                <Plus className="h-4 w-4" />
                New Stock Template
              </button>
            </div>
            <DataListTable
              columns={[{ key: "name", label: "Naam" }, { key: "id", label: "ID" }]}
              rows={stockTemplates}
              emptyMessage="No stock templates yet."
              onRowClick={(row) => navigate(`/settings/locations/${locationId}/stock-templates/${row.id}`)}
            />
          </Card>
        )}
      </PageContainer></div>;
}
