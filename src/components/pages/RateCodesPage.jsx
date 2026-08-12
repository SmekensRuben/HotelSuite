import React, { useMemo, useState } from "react";
import { ArrowLeft, Pencil, Plus, Trash2, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import DataListTable from "../shared/DataListTable";
import YesNoToggle from "../ui/YesNoToggle";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { addRateCode, deleteRateCode, subscribeRateCodes, updateRateCode } from "../../services/firebaseRateCodes";

const createEmptyForm = () => ({ prefix: "", code: "", description: "", marketSegment: "", breakfastIncluded: false });

export default function RateCodesPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [rateCodes, setRateCodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(createEmptyForm);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const todayLabel = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);

  React.useEffect(() => {
    setLoading(true);
    setError("");
    const unsubscribe = subscribeRateCodes(
      hotelUid,
      (items) => { setRateCodes(items); setLoading(false); },
      (err) => { console.error("Unable to load Rate Codes:", err); setError("The Rate Codes could not be loaded from Firebase."); setLoading(false); }
    );
    if (!hotelUid) setLoading(false);
    return unsubscribe;
  }, [hotelUid]);

  const resetForm = () => { setShowForm(false); setEditingId(null); setForm(createEmptyForm()); setError(""); };
  const save = async (event) => {
    event.preventDefault();
    const payload = {
      prefix: form.prefix.trim(),
      code: form.code.trim(),
      description: form.description.trim(),
      marketSegment: form.marketSegment.trim(),
      breakfastIncluded: Boolean(form.breakfastIncluded),
    };
    if (!payload.prefix || !payload.code || !payload.description || !payload.marketSegment) {
      setError("Enter a prefix, code, description and market segment.");
      return;
    }
    if (payload.prefix.includes("/") || payload.code.includes("/")) {
      setError("Prefix and code cannot contain a slash.");
      return;
    }

    setSaving(true); setError("");
    try {
      if (editingId) await updateRateCode(hotelUid, editingId, payload);
      else await addRateCode(hotelUid, payload);
      resetForm();
    } catch (err) {
      console.error("Unable to save Rate Code:", err);
      setError(err?.message || "The Rate Code could not be saved in Firebase.");
    } finally { setSaving(false); }
  };

  const edit = (rateCode) => {
    setEditingId(rateCode.id);
    setForm({
      prefix: rateCode.prefix || "",
      code: rateCode.code || "",
      description: rateCode.description || "",
      marketSegment: rateCode.marketSegment || "",
      breakfastIncluded: Boolean(rateCode.breakfastIncluded),
    });
    setShowForm(true);
    setError("");
  };

  const columns = useMemo(() => [
    { key: "prefix", label: "Prefix", render: (item) => <span className="font-mono font-semibold">{item.prefix}</span> },
    { key: "code", label: "Code", render: (item) => <span className="font-mono font-semibold">{item.code}</span> },
    { key: "description", label: "Description" },
    { key: "marketSegment", label: "Market Segment" },
    { key: "breakfastIncluded", label: "Breakfast Included", render: (item) => item.breakfastIncluded ? "Yes" : "No" },
    { key: "actions", label: "Actions", sortable: false, render: (item) => <div className="flex gap-2">
      <button aria-label={`Edit ${item.id}`} onClick={() => edit(item)} className="rounded-lg border p-2 text-blue-700 hover:bg-blue-50"><Pencil className="h-4 w-4" /></button>
      <button aria-label={`Delete ${item.id}`} onClick={async () => { if (window.confirm(`Delete Rate Code ${item.id}?`)) await deleteRateCode(hotelUid, item.id); }} className="rounded-lg border p-2 text-red-700 hover:bg-red-50"><Trash2 className="h-4 w-4" /></button>
    </div> },
  ], [hotelUid]);

  const handleLogout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };
  return <div className="min-h-screen bg-gray-50 text-gray-900">
    <HeaderBar today={todayLabel} onLogout={handleLogout} />
    <PageContainer className="space-y-6">
      <div>
        <button onClick={() => navigate("/settings/property")} className="mb-3 inline-flex items-center gap-2 text-sm font-semibold text-blue-700"><ArrowLeft className="h-4 w-4" />Property Settings</button>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div><p className="text-sm uppercase tracking-wide text-gray-500">Property Settings</p><h1 className="text-3xl font-semibold">Rate Codes</h1><p className="mt-2 text-gray-600">Manage the rate codes available for this property.</p></div>
          {!showForm && <button onClick={() => { setForm(createEmptyForm()); setShowForm(true); }} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"><Plus className="h-4 w-4" />Add Rate Code</button>}
        </div>
      </div>

      {showForm && <Card>
        <div className="flex justify-between"><h2 className="text-lg font-semibold">{editingId ? "Edit Rate Code" : "New Rate Code"}</h2><button aria-label="Close form" onClick={resetForm}><X className="h-5 w-5" /></button></div>
        <form onSubmit={save} className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-[8rem_9rem_1fr_1fr_auto_auto] xl:items-end">
          <label className="text-sm font-semibold">Prefix<input required aria-label="Rate code prefix" value={form.prefix} onChange={(event) => setForm({ ...form, prefix: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2 font-normal" /></label>
          <label className="text-sm font-semibold">Code<input required aria-label="Rate code code" value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2 font-normal" /></label>
          <label className="text-sm font-semibold">Description<input required aria-label="Rate code description" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2 font-normal" /></label>
          <label className="text-sm font-semibold">Market Segment<input required aria-label="Rate code market segment" value={form.marketSegment} onChange={(event) => setForm({ ...form, marketSegment: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2 font-normal" /></label>
          <div><span className="mb-2 block text-sm font-semibold">Breakfast Included</span><YesNoToggle value={form.breakfastIncluded} onChange={(value) => setForm({ ...form, breakfastIncluded: value })} /></div>
          <button disabled={saving} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">{saving ? "Saving..." : "Save"}</button>
        </form>
        {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
      </Card>}

      {error && !showForm && <p className="text-sm text-red-700">{error}</p>}
      {loading ? <Card><p className="text-sm text-gray-500">Loading Rate Codes...</p></Card> : <DataListTable columns={columns} rows={rateCodes} emptyMessage="No Rate Codes yet. Add the first Rate Code to start configuring this property." />}
    </PageContainer>
  </div>;
}
