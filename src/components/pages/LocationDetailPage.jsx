import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Pencil } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getLocationById } from "../../services/firebaseSettings";
import { usePermission } from "../../hooks/usePermission";

export default function LocationDetailPage() {
  const navigate = useNavigate();
  const { locationId } = useParams();
  const { hotelUid } = useHotelContext();
  const canEditLocations = usePermission("locations", "update");
  const [location, setLocation] = useState(null);
  const [loading, setLoading] = useState(true);
  const today = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);
  const handleLogout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };

  useEffect(() => {
    const loadLocation = async () => {
      if (!hotelUid || !locationId) return;
      setLoading(true);
      setLocation(await getLocationById(hotelUid, locationId));
      setLoading(false);
    };
    loadLocation();
  }, [hotelUid, locationId]);

  return <div className="min-h-screen bg-gray-50 text-gray-900"><HeaderBar today={today} onLogout={handleLogout} /><PageContainer className="space-y-6"><div className="flex items-center justify-between gap-3"><h1 className="text-3xl font-semibold">Location Detail</h1><div className="flex items-center gap-2"><button type="button" onClick={() => navigate("/settings/locations")} className="inline-flex items-center justify-center rounded border border-gray-300 p-2 text-gray-700 hover:bg-gray-100" title="Back to locations"><ArrowLeft className="h-4 w-4" /></button><button type="button" onClick={() => navigate(`/settings/locations/${locationId}/edit`)} disabled={!canEditLocations} className={`inline-flex items-center justify-center rounded border p-2 ${canEditLocations ? "border-gray-300 text-gray-700 hover:bg-gray-100" : "border-gray-200 text-gray-400 cursor-not-allowed"}`} title="Edit location"><Pencil className="h-4 w-4" /></button></div></div>{loading ? <p className="text-gray-600">Loading location...</p> : !location ? <Card><p className="text-gray-600">Location not found.</p></Card> : <Card><h2 className="text-2xl font-semibold">{location.name || "-"}</h2><p className="text-gray-600 mt-1">ID: {location.id || "-"}</p></Card>}</PageContainer></div>;
}
