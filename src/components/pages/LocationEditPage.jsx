import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getLocationById, updateLocation } from "../../services/firebaseSettings";

export default function LocationEditPage() {
  const navigate = useNavigate();
  const { locationId } = useParams();
  const { hotelUid } = useHotelContext();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const today = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);
  const handleLogout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };

  useEffect(() => {
    const init = async () => {
      if (!hotelUid || !locationId) return;
      const location = await getLocationById(hotelUid, locationId);
      setName(String(location?.name || ""));
    };
    init();
  }, [hotelUid, locationId]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!hotelUid || !locationId || !name.trim()) return;
    setSaving(true);
    await updateLocation(hotelUid, locationId, { name: name.trim(), updatedBy: auth.currentUser?.uid || "unknown" });
    setSaving(false);
    navigate(`/settings/locations/${locationId}`);
  };

  return <div className="min-h-screen bg-gray-50 text-gray-900"><HeaderBar today={today} onLogout={handleLogout} /><PageContainer className="space-y-6"><div><p className="text-sm text-gray-500 uppercase tracking-wide">Settings</p><h1 className="text-3xl font-semibold">Edit Location</h1></div><Card><form onSubmit={handleSubmit} className="space-y-4"><div><label htmlFor="location-name" className="block text-sm font-medium text-gray-700 mb-1">Name</label><input id="location-name" type="text" value={name} onChange={(event) => setName(event.target.value)} placeholder="Location name" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" required /></div><div className="flex justify-end gap-2"><button type="button" onClick={() => navigate(`/settings/locations/${locationId}`)} className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium hover:bg-gray-100">Cancel</button><button type="submit" disabled={saving} className="px-4 py-2 rounded-lg bg-[#b41f1f] text-white text-sm font-semibold hover:bg-[#961919] disabled:opacity-60">{saving ? "Saving..." : "Save Location"}</button></div></form></Card></PageContainer></div>;
}
