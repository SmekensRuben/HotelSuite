import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getGroupQuoteSettings, saveGroupQuoteSettings } from "../../services/firebaseQuotes";

export default function GroupQuoteSettingsPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [inflationPercentage, setInflationPercentage] = useState("");
  const [displacementThresholdPercentage, setDisplacementThresholdPercentage] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const today = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);
  const handleLogout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };

  useEffect(() => {
    if (!hotelUid) return;
    getGroupQuoteSettings(hotelUid).then((settings) => {
      setInflationPercentage(settings.inflationPercentage ?? "");
      setDisplacementThresholdPercentage(settings.displacementThresholdPercentage ?? "");
      setLoading(false);
    });
  }, [hotelUid]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSaving(true);
    await saveGroupQuoteSettings(hotelUid, {
      inflationPercentage: Number(inflationPercentage),
      displacementThresholdPercentage: Number(displacementThresholdPercentage),
    });
    setSaving(false);
    navigate("/revenue/group-quotes");
  };

  return <div className="min-h-screen bg-gray-50 text-gray-900"><HeaderBar today={today} onLogout={handleLogout} /><PageContainer className="space-y-6">
    <div className="flex items-center justify-between"><div><p className="text-sm uppercase tracking-wide text-gray-500">Revenue / Group Quotes</p><h1 className="text-3xl font-semibold">Group Quote Settings</h1></div><button type="button" onClick={() => navigate("/revenue/group-quotes")} className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold hover:bg-gray-100"><ArrowLeft className="h-4 w-4" /> Back to overview</button></div>
    <Card>{loading ? <p>Loading settings...</p> : <form onSubmit={handleSubmit} className="space-y-5"><div className="grid max-w-3xl gap-4 sm:grid-cols-2"><label className="block text-sm font-semibold">Inflation %<input required min="0" step="0.01" type="number" value={inflationPercentage} onChange={(event) => setInflationPercentage(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal" /></label><label className="block text-sm font-semibold">Displacement Threshold %<input required min="0" max="100" step="0.01" type="number" value={displacementThresholdPercentage} onChange={(event) => setDisplacementThresholdPercentage(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal" /></label></div><div><button disabled={saving} className="rounded-lg bg-[#b41f1f] px-5 py-2 font-semibold text-white disabled:bg-gray-400">{saving ? "Saving..." : "Save Settings"}</button></div></form>}</Card>
  </PageContainer></div>;
}
