import React, { useEffect, useState } from "react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { auth, signOut } from "../../firebaseConfig";
import { getHotelSubscriptions, saveHotelSubscription } from "../../services/firebaseSubscriptions";
const LABELS = { trialing: "Proefperiode", active: "Actief", suspended: "Gepauzeerd", canceled: "Stopgezet" };

export default function SubscriptionsPage() {
  const [hotels, setHotels] = useState([]);
  const [selected, setSelected] = useState("");
  const [status, setStatus] = useState("active");
  const [planId, setPlanId] = useState("standard");
  const [validUntil, setValidUntil] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const current = hotels.find((hotel) => hotel.hotelUid === selected);
  const select = (hotel) => {
    setSelected(hotel.hotelUid); setStatus(hotel.subscription?.status || "active");
    setPlanId(hotel.subscription?.planId || "standard");
    setValidUntil(hotel.subscription?.validUntil?.toDate?.().toISOString().slice(0, 10) || "");
    setMessage("");
  };
  useEffect(() => {
    let canceled = false;
    getHotelSubscriptions().then((records) => {
      if (canceled) return;
      setHotels(records); if (records.length) select(records[0]);
    }).catch(() => { if (!canceled) setMessage("Abonnementen konden niet geladen worden. Herlaad de pagina."); })
      .finally(() => { if (!canceled) setLoading(false); });
    return () => { canceled = true; };
  }, []);
  const save = async (event) => {
    event.preventDefault(); if (!current || saving) return;
    setSaving(true); setMessage("");
    try {
      const result = await saveHotelSubscription({ hotelUid: selected, status, planId,
        validUntil: validUntil ? new Date(`${validUntil}T00:00:00Z`).toISOString() : null,
        expectedRevision: current.subscription?.revision || 0 });
      setHotels(await getHotelSubscriptions());
      setMessage(`Abonnement opgeslagen (versie ${result.revision}).`);
    } catch (error) {
      setMessage(error?.code === "functions/aborted"
        ? "Dit abonnement is ondertussen gewijzigd. Herlaad de pagina voor je opnieuw opslaat."
        : "Opslaan mislukt. Controleer de gegevens en probeer opnieuw.");
    } finally { setSaving(false); }
  };
  return <div className="min-h-screen bg-gray-50 text-gray-900">
    <HeaderBar today={new Date().toLocaleDateString()} onLogout={() => signOut(auth)} />
    <PageContainer className="space-y-6">
      <h1 className="text-3xl font-semibold">Abonnementen per hotel</h1>
      <p className="text-gray-600">Activeer hoteltoegang nadat de facturatie geregeld is. Pauzeren of stopzetten blokkeert de toegang tot hotelmodules.</p>
      {loading ? <p>Abonnementen laden...</p> : !hotels.length ? <p>Er zijn nog geen hotels beschikbaar.</p> : <>
        <div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full text-left text-sm">
          <thead><tr className="bg-gray-100"><th className="p-3">Hotel</th><th className="p-3">Status</th><th className="p-3">Plan</th><th className="p-3">Toegang tot</th></tr></thead>
          <tbody>{hotels.map((hotel) => <tr key={hotel.hotelUid} className="border-t">
            <td className="p-3"><button className="font-semibold text-[#b41f1f] underline" disabled={saving} onClick={() => select(hotel)}>{hotel.hotelName}</button></td>
            <td className="p-3">{LABELS[hotel.subscription?.status] || "Niet ingesteld"}</td>
            <td className="p-3">{hotel.subscription?.planId || "—"}</td>
            <td className="p-3">{hotel.subscription?.validUntil?.toDate?.().toISOString().slice(0, 10) || "Geen einddatum"}</td>
          </tr>)}</tbody></table></div>
        <form onSubmit={save} className="space-y-4 rounded-xl border bg-white p-6">
          <h2 className="text-xl font-semibold">{current?.hotelName}</h2>
          <label className="block">Status<select disabled={saving} value={status} onChange={(e) => setStatus(e.target.value)} className="ml-3 rounded border p-2">{Object.entries(LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="block">Plan<input disabled={saving} required pattern="[a-zA-Z0-9_-]{1,60}" value={planId} onChange={(e) => setPlanId(e.target.value)} className="ml-3 rounded border p-2" /></label>
          <label className="block">Eerste dag zonder toegang<input disabled={saving} type="date" required={status === "trialing"} value={validUntil} onChange={(e) => setValidUntil(e.target.value)} className="ml-3 rounded border p-2" /><span className="ml-3 text-sm text-gray-500">Vanaf 00:00 UTC. Leeg = geen einddatum.</span></label>
          <button disabled={saving} className="rounded bg-[#b41f1f] px-4 py-2 font-semibold text-white disabled:opacity-50">{saving ? "Opslaan..." : "Abonnement opslaan"}</button>
        </form>
      </>}
      {message && <p role="status">{message}</p>}
    </PageContainer>
  </div>;
}
