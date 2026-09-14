import React, { useEffect, useMemo, useState } from "react";
import { getCompsetConfiguration, saveCompsetConfiguration } from "../../services/firebaseQuotes";

const blankCompetitor = (index) => ({ id: `competitor-${index + 1}`, displayName: "", lighthouseFieldName: "", active: true, includeInMarketContext: true, marketRelevanceWeight: 0, groupIntelligenceEnabled: true, strategyNotes: "", sortOrder: index });

export default function CompsetSettings({ hotelUid }) {
  const [settings, setSettings] = useState({ ownHotelLighthouseFieldName: "" });
  const [competitors, setCompetitors] = useState([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { if (hotelUid) getCompsetConfiguration(hotelUid).then((data) => { setSettings(data.settings); setCompetitors(data.competitors); }); }, [hotelUid]);
  const includedWeight = useMemo(() => competitors.filter((item) => item.active && item.includeInMarketContext && Number(item.marketRelevanceWeight) > 0).reduce((sum, item) => sum + Number(item.marketRelevanceWeight), 0), [competitors]);
  const update = (index, key, value) => setCompetitors((current) => current.map((item, position) => position === index ? { ...item, [key]: value } : item));
  const submit = async (event) => { event.preventDefault(); setSaving(true); setMessage(""); try { await saveCompsetConfiguration(hotelUid, settings, competitors); setMessage("Market pricing configuration saved."); } catch (error) { setMessage(error.message); } finally { setSaving(false); } };
  return <form onSubmit={submit} className="space-y-5">
    <div><p className="text-xs font-semibold uppercase tracking-widest text-gray-500">Market Pricing</p><h2 className="text-xl font-semibold">Compset configuration</h2><p className="text-sm text-gray-600">Lighthouse public consumer rates already include VAT. Weights are normalized automatically and do not need to total 100.</p></div>
    <label className="block max-w-xl text-sm font-semibold">Own Lighthouse field mapping<input value={settings.ownHotelLighthouseFieldName || ""} onChange={(e) => setSettings({ ...settings, ownHotelLighthouseFieldName: e.target.value })} className="mt-1 w-full rounded border px-3 py-2 font-normal" placeholder="Exact Lighthouse column name" /></label>
    <div className="space-y-4">{competitors.map((item, index) => <fieldset key={item.id} className="rounded-lg border border-gray-200 p-4"><legend className="px-1 font-semibold">{item.displayName || item.id}</legend><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <label className="text-sm">ID<input required value={item.id} onChange={(e) => update(index, "id", e.target.value)} className="mt-1 w-full rounded border px-2 py-1" /></label><label className="text-sm">Display name<input required value={item.displayName || ""} onChange={(e) => update(index, "displayName", e.target.value)} className="mt-1 w-full rounded border px-2 py-1" /></label><label className="text-sm">Lighthouse field<input value={item.lighthouseFieldName || ""} onChange={(e) => update(index, "lighthouseFieldName", e.target.value)} className="mt-1 w-full rounded border px-2 py-1" /></label>
      <label className="text-sm">Relevance weight<input min="0" required type="number" step="0.01" value={item.marketRelevanceWeight} onChange={(e) => update(index, "marketRelevanceWeight", e.target.value)} className="mt-1 w-full rounded border px-2 py-1" /><span className="text-xs text-gray-500">Effective: {includedWeight && item.active && item.includeInMarketContext ? `${(Number(item.marketRelevanceWeight) / includedWeight * 100).toFixed(1)}%` : "0.0%"}</span></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(item.active)} onChange={(e) => update(index, "active", e.target.checked)} /> Active</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(item.includeInMarketContext)} onChange={(e) => update(index, "includeInMarketContext", e.target.checked)} /> Include in market context</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(item.groupIntelligenceEnabled)} onChange={(e) => update(index, "groupIntelligenceEnabled", e.target.checked)} /> Group intelligence enabled</label>
      <label className="text-sm lg:col-span-4">Strategy notes (informational only)<textarea value={item.strategyNotes || ""} onChange={(e) => update(index, "strategyNotes", e.target.value)} className="mt-1 w-full rounded border px-2 py-1" /></label>
    </div></fieldset>)}</div>
    <div className="flex gap-3"><button type="button" onClick={() => setCompetitors([...competitors, blankCompetitor(competitors.length)])} className="rounded border px-4 py-2 text-sm font-semibold">Add competitor</button><button disabled={saving} className="rounded bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white disabled:bg-gray-400">{saving ? "Saving…" : "Save Compset"}</button></div>{message && <p role="status" className="text-sm font-medium">{message}</p>}
  </form>;
}
