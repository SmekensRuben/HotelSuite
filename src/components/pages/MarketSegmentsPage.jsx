import React, { useMemo, useRef, useState } from "react";
import { ArrowLeft, Download, Pencil, Plus, Trash2, Upload, X } from "lucide-react";
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
import { createMarketSegmentsExport, parseMarketSegmentsImport } from "../../utils/marketSegmentTransfer";

const createEmptyPrefix = () => ({ prefix: "", name: "", description: "" });
const createEmptyForm = () => ({ title: "", prefixes: [createEmptyPrefix()] });

export default function MarketSegmentsPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [marketSegments, setMarketSegments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(createEmptyForm);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef(null);
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

  const resetForm = () => { setShowForm(false); setEditingId(null); setForm(createEmptyForm()); setError(""); };
  const save = async (event) => {
    event.preventDefault();
    const payload = {
      title: form.title.trim(),
      prefixes: form.prefixes.map((item) => ({
        prefix: item.prefix.trim(),
        name: item.name.trim(),
        description: item.description.trim(),
      })),
    };
    if (!payload.title || payload.prefixes.some((item) => !item.prefix || !item.name || !item.description)) {
      setError("Enter a title and a prefix, name and description for every row.");
      return;
    }
    if (payload.prefixes.some((item) => item.prefix.includes("/"))) {
      setError("Prefixes cannot contain a slash.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      if (editingId) await updateMarketSegment(hotelUid, editingId, payload);
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
    setEditingId(marketSegment.id);
    setForm({
      title: marketSegment.title || "",
      prefixes: marketSegment.prefixes?.length
        ? marketSegment.prefixes.map(({ prefix = "", name = "", description = "" }) => ({ prefix, name, description }))
        : [createEmptyPrefix()],
    });
    setShowForm(true);
    setError("");
  };

  const exportMarketSegments = () => {
    const blob = new Blob([JSON.stringify(createMarketSegmentsExport(marketSegments), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "market-segments.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  const importMarketSegments = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setImporting(true);
    setError("");
    try {
      const importedMarketSegments = parseMarketSegmentsImport(await file.text());
      await Promise.all(importedMarketSegments.map((marketSegment) => addMarketSegment(hotelUid, marketSegment)));
    } catch (err) {
      console.error("Unable to import Market Segments:", err);
      setError(err?.message || "The Market Segments could not be imported.");
    } finally {
      setImporting(false);
    }
  };

  const columns = useMemo(() => [
    { key: "title", label: "Title", render: (item) => <span className="font-semibold">{item.title}</span> },
    { key: "prefixes", label: "Prefixes", sortValue: (item) => item.prefixes?.map(({ prefix }) => prefix).join(" ") || "", render: (item) => <div className="space-y-1">
      {(item.prefixes || []).map(({ prefix, name, description }, index) => <div key={`${prefix}-${index}`}><span className="font-mono font-semibold">{prefix}</span><span className="font-medium"> — {name}</span><span className="text-gray-500"> — {description}</span></div>)}
    </div> },
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
          <div className="flex flex-wrap gap-2">
            <input ref={importInputRef} type="file" accept="application/json,.json" onChange={importMarketSegments} className="hidden" />
            <button type="button" disabled={importing} onClick={() => importInputRef.current?.click()} className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"><Upload className="h-4 w-4" />{importing ? "Importing..." : "Import"}</button>
            <button type="button" disabled={marketSegments.length === 0} onClick={exportMarketSegments} className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"><Download className="h-4 w-4" />Export</button>
            {!showForm && <button onClick={() => { setForm(createEmptyForm()); setShowForm(true); }} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"><Plus className="h-4 w-4" />Add Market Segment</button>}
          </div>
        </div>
      </div>

      {showForm && <Card>
        <div className="flex justify-between"><h2 className="text-lg font-semibold">{editingId ? "Edit Market Segment" : "New Market Segment"}</h2><button aria-label="Close form" onClick={resetForm}><X className="h-5 w-5" /></button></div>
        <form onSubmit={save} className="mt-4 space-y-4">
          <label className="block max-w-xl text-sm font-semibold">Title<input required aria-label="Market segment title" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2 font-normal" /></label>
          <div className="space-y-3">
            <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">Prefixes</h3><button type="button" onClick={() => setForm({ ...form, prefixes: [...form.prefixes, createEmptyPrefix()] })} className="inline-flex items-center gap-1 text-sm font-semibold text-blue-700 hover:text-blue-900"><Plus className="h-4 w-4" />Add Prefix</button></div>
            {form.prefixes.map((item, index) => <div key={index} className="grid gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3 md:grid-cols-[1fr_1.5fr_2fr_auto] md:items-end">
              <label className="text-sm font-semibold">Prefix<input required aria-label={`Prefix ${index + 1}`} value={item.prefix} onChange={(event) => setForm({ ...form, prefixes: form.prefixes.map((prefix, rowIndex) => rowIndex === index ? { ...prefix, prefix: event.target.value } : prefix) })} className="mt-1 w-full rounded-lg border bg-white px-3 py-2 font-normal" /></label>
              <label className="text-sm font-semibold">Name<input required aria-label={`Prefix name ${index + 1}`} value={item.name} onChange={(event) => setForm({ ...form, prefixes: form.prefixes.map((prefix, rowIndex) => rowIndex === index ? { ...prefix, name: event.target.value } : prefix) })} className="mt-1 w-full rounded-lg border bg-white px-3 py-2 font-normal" /></label>
              <label className="text-sm font-semibold">Description<input required aria-label={`Prefix description ${index + 1}`} value={item.description} onChange={(event) => setForm({ ...form, prefixes: form.prefixes.map((prefix, rowIndex) => rowIndex === index ? { ...prefix, description: event.target.value } : prefix) })} className="mt-1 w-full rounded-lg border bg-white px-3 py-2 font-normal" /></label>
              <button type="button" aria-label={`Remove prefix ${index + 1}`} disabled={form.prefixes.length === 1} onClick={() => setForm({ ...form, prefixes: form.prefixes.filter((_, rowIndex) => rowIndex !== index) })} className="rounded-lg border p-2 text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="h-4 w-4" /></button>
            </div>)}
          </div>
          <div className="flex justify-end"><button disabled={saving} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">{saving ? "Saving..." : "Save"}</button></div>
        </form>
        {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
      </Card>}

      {error && !showForm && <p className="text-sm text-red-700">{error}</p>}
      {loading ? <Card><p className="text-sm text-gray-500">Loading Market Segments...</p></Card> : <DataListTable columns={columns} rows={marketSegments} emptyMessage="No Market Segments yet. Add the first Market Segment to start configuring this property." />}
    </PageContainer>
  </div>;
}
