import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Pencil, Plus } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import Modal from "../shared/Modal";
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
  const [showNewTemplateModal, setShowNewTemplateModal] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");

  const today = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);
  const handleLogout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };

  const handleCreateStockTemplate = async () => {
    const cleanedName = newTemplateName.trim();
    if (!cleanedName) return;
    await createLocationStockTemplate(hotelUid, locationId, cleanedName);
    setStockTemplates(await getLocationStockTemplates(hotelUid, locationId));
    setNewTemplateName("");
    setShowNewTemplateModal(false);
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

  const templateRows = stockTemplates.map((template) => ({
    ...template,
    itemCount: Array.isArray(template.items) ? template.items.length : 0,
  }));

  return <div className="min-h-screen bg-gray-50 text-gray-900"><HeaderBar today={today} onLogout={handleLogout} /><PageContainer className="space-y-6"><div className="flex items-center justify-between gap-3"><h1 className="text-3xl font-semibold">Location Detail</h1><div className="flex items-center gap-2"><button type="button" onClick={() => navigate("/settings/locations")} className="inline-flex items-center justify-center rounded border border-gray-300 p-2 text-gray-700 hover:bg-gray-100" title="Back to locations"><ArrowLeft className="h-4 w-4" /></button><button type="button" onClick={() => navigate(`/settings/locations/${locationId}/edit`)} disabled={!canEditLocations} className={`inline-flex items-center justify-center rounded border p-2 ${canEditLocations ? "border-gray-300 text-gray-700 hover:bg-gray-100" : "border-gray-200 text-gray-400 cursor-not-allowed"}`} title="Edit location"><Pencil className="h-4 w-4" /></button></div></div>{loading ? <p className="text-gray-600">Loading location...</p> : !location ? <Card><p className="text-gray-600">Location not found.</p></Card> : <Card><h2 className="text-2xl font-semibold">{location.name || "-"}</h2></Card>}

        {!loading && location && (
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-semibold">Stock Templates</h3>
              <button type="button" onClick={() => setShowNewTemplateModal(true)} className="inline-flex items-center gap-2 rounded border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100">
                <Plus className="h-4 w-4" />
                New Stock Template
              </button>
            </div>
            <DataListTable
              columns={[{ key: "name", label: "Name" }, { key: "itemCount", label: "Stock Template Items" }]}
              rows={templateRows}
              emptyMessage="No stock templates yet."
              onRowClick={(row) => navigate(`/settings/locations/${locationId}/stock-templates/${row.id}`)}
            />
          </Card>
        )}
      </PageContainer>
      <Modal open={showNewTemplateModal} onClose={() => setShowNewTemplateModal(false)} title="New Stock Template">
        <div className="space-y-3">
          <input
            type="text"
            value={newTemplateName}
            onChange={(event) => setNewTemplateName(event.target.value)}
            placeholder="Stock template name"
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
          <div className="flex justify-end gap-2">
            <button type="button" className="rounded border border-gray-300 px-3 py-2 text-sm" onClick={() => setShowNewTemplateModal(false)}>Cancel</button>
            <button type="button" className="rounded bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-60" disabled={!newTemplateName.trim()} onClick={handleCreateStockTemplate}>Save</button>
          </div>
        </div>
      </Modal>
    </div>;
}
