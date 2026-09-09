import React, { useMemo, useState } from "react";
import { ArrowLeft, Pencil, Plus, Trash2, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import {
  addMarketSegment,
  deleteMarketSegment,
  subscribeMarketSegments,
  updateMarketSegment,
} from "../../services/firebaseMarketSegments";

const createEmptyForm = () => ({ prefix: "", description: "" });

export default function MarketSegmentsPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [marketSegments, setMarketSegments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingPrefix, setEditingPrefix] = useState(null);
  const [form, setForm] = useState(createEmptyForm);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const todayLabel = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);

  React.useEffect(() => {
    setLoading(true);
    setError("");
    const unsubscribe = subscribeMarketSegments(
      hotelUid,
      (items) => { setMarketSegments(items); setLoading(false); },
      (err) => { console.error("Unable to load Market Segments:", err); setError("The Market Segments could not be loaded from Firebase."); setLoading(false); }
    );
    if (!hotelUid) setLoading(false);
    return unsubscribe;
  }, [hotelUid]);

  const resetForm = () => { setShowForm(false); setEditingPrefix(null); setForm(createEmptyForm()); setError(""); };
  const save = async (event) => {
    event.preventDefault();
    const payload = { prefix: form.prefix.trim(), description: form.description.trim() };
    if (!payload.prefix || !payload.description) {
      setError("Enter a prefix and description.");
      return;
    }
    if (payload.prefix.includes("/")) {
      setError("Prefix cannot contain a slash.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      if (editingPrefix) await updateMarketSegment(hotelUid, editingPrefix, payload);
      else await addMarketSegment(hotelUid, payload);
      resetForm();
    } catch (err) {
      console.error("Unable to save Market Segment:", err);
      setError(err?.message || "The Market Segment could not be saved in Firebase.");
    } finally {
      setSaving(false);
    }
  };

  const edit = (marketSegment) => {
    setEditingPrefix(marketSegment.id);
    setForm({ prefix: marketSegment.prefix || marketSegment.id, description: marketSegment.description || "" });
    setShowForm(true);
    setError("");
  };

  const columns = useMemo(() => [
    { key: "prefix", label: "Prefix", render: (item) => <span className="font-mono font-semibold">{item.prefix || item.id}</span> },
    { key: "description", label: "Description" },
    { key: "actions", label: "Actions", sortable: false, render: (item) => <div className="flex gap-2">
      <button aria-label={`Edit ${item.id}`} onClick={() => edit(item)} className="rounded-lg border p-2 text-blue-700 hover:bg-blue-50"><Pencil className="h-4 w-4" /></button>
      <button aria-label={`Delete ${item.id}`} onClick={async () => { if (window.confirm(`Delete Market Segment ${item.id}?`)) await deleteMarketSegment(hotelUid, item.id); }} className="rounded-lg border p-2 text-red-700 hover:bg-red-50"><Trash2 className="h-4 w-4" /></button>
    </div> },
  ], [hotelUid]);

  const handleLogout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };
  return <div className="min-h-screen bg-gray-50 text-gray-900">
    <HeaderBar today={todayLabel} onLogout={handleLogout} />
    <PageContainer className="space-y-6">
      <div>
        <button onClick={() => navigate("/settings/property")} className="mb-3 inline-flex items-center gap-2 text-sm font-semibold text-blue-700"><ArrowLeft className="h-4 w-4" />Property Settings</button>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div><p className="text-sm uppercase tracking-wide text-gray-500">Property Settings</p><h1 className="text-3xl font-semibold">Market Segments</h1><p className="mt-2 text-gray-600">Manage the market segments available for this property.</p></div>
          {!showForm && <button onClick={() => { setForm(createEmptyForm()); setShowForm(true); }} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"><Plus className="h-4 w-4" />Add Market Segment</button>}
        </div>
      </div>

      {showForm && <Card>
        <div className="flex justify-between"><h2 className="text-lg font-semibold">{editingPrefix ? "Edit Market Segment" : "New Market Segment"}</h2><button aria-label="Close form" onClick={resetForm}><X className="h-5 w-5" /></button></div>
        <form onSubmit={save} className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4 xl:items-end">
          <label className="text-sm font-semibold">Prefix<input required aria-label="Market segment prefix" value={form.prefix} onChange={(event) => setForm({ ...form, prefix: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2 font-normal" /></label>
          <label className="text-sm font-semibold">Description<input required aria-label="Market segment description" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2 font-normal" /></label>
          <button disabled={saving} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">{saving ? "Saving..." : "Save"}</button>
        </form>
        {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
      </Card>}

      {error && !showForm && <p className="text-sm text-red-700">{error}</p>}
      {loading ? <Card><p className="text-sm text-gray-500">Loading Market Segments...</p></Card> : <DataListTable columns={columns} rows={marketSegments} emptyMessage="No Market Segments yet. Add the first Market Segment to start configuring this property." />}
    </PageContainer>
  </div>;
}
