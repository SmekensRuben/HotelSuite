import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { createLocation } from "../../services/firebaseSettings";

export default function LocationCreatePage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const today = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);

  const handleLogout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!hotelUid || !name.trim()) return;
    setSaving(true);
    await createLocation(hotelUid, { name: name.trim(), createdBy: auth.currentUser?.uid || "unknown" });
    setSaving(false);
    navigate("/settings/locations");
  };

  return <div className="min-h-screen bg-gray-50 text-gray-900"><HeaderBar today={today} onLogout={handleLogout} /><PageContainer className="space-y-6"><div><p className="text-sm text-gray-500 uppercase tracking-wide">Settings</p><h1 className="text-3xl font-semibold">Add Location</h1></div><Card><form onSubmit={handleSubmit} className="space-y-4"><div><label htmlFor="location-name" className="block text-sm font-medium text-gray-700 mb-1">Name</label><input id="location-name" type="text" value={name} onChange={(event) => setName(event.target.value)} placeholder="Location name" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20" required /></div><div className="flex justify-end gap-2"><button type="button" onClick={() => navigate("/settings/locations")} className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium hover:bg-gray-100">Cancel</button><button type="submit" disabled={saving} className="px-4 py-2 rounded-lg bg-[#b41f1f] text-white text-sm font-semibold hover:bg-[#961919] disabled:opacity-60">{saving ? "Saving..." : "Save Location"}</button></div></form></Card></PageContainer></div>;
}
