import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Upload } from "lucide-react";
import * as XLSX from "xlsx";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getGroupQuoteSettings, saveGroupQuoteSettings } from "../../services/firebaseQuotes";
import { saveLighthouseData } from "../../services/firebaseLighthouse";
import { getLocalIsoDate, parseLighthouseRows } from "../../utils/lighthouseImport";

export default function GroupQuoteSettingsPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [inflationPercentage, setInflationPercentage] = useState("");
  const [displacementThresholdPercentage, setDisplacementThresholdPercentage] = useState("");
  const [maxHistoricalGroupSharePercentage, setMaxHistoricalGroupSharePercentage] = useState("");
  const [roomVatPercentage, setRoomVatPercentage] = useState("");
  const [breakfastAllocation, setBreakfastAllocation] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState(null);
  const fileInputRef = useRef(null);
  const today = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);
  const handleLogout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };

  useEffect(() => {
    if (!hotelUid) return;
    getGroupQuoteSettings(hotelUid).then((settings) => {
      setInflationPercentage(settings.inflationPercentage ?? "");
      setDisplacementThresholdPercentage(settings.displacementThresholdPercentage ?? "");
      setMaxHistoricalGroupSharePercentage(settings.maxHistoricalGroupSharePercentage ?? "");
      setRoomVatPercentage(settings.roomVatPercentage ?? "");
      setBreakfastAllocation(settings.breakfastAllocation ?? "");
      setLoading(false);
    });
  }, [hotelUid]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSaving(true);
    await saveGroupQuoteSettings(hotelUid, {
      inflationPercentage: Number(inflationPercentage),
      displacementThresholdPercentage: Number(displacementThresholdPercentage),
      maxHistoricalGroupSharePercentage: Number(maxHistoricalGroupSharePercentage),
      roomVatPercentage: Number(roomVatPercentage),
      breakfastAllocation: Number(breakfastAllocation),
    });
    setSaving(false);
    navigate("/revenue/group-quotes");
  };

  const handleLighthouseImport = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setImporting(true);
    setImportMessage(null);
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
      const ratesSheetName = workbook.SheetNames.find((name) => name.trim().toLowerCase() === "rates");
      if (!ratesSheetName) throw new Error('Het Excel-bestand bevat geen tabblad "Rates".');
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[ratesSheetName], {
        header: 1,
        defval: "",
        raw: false,
      });
      const lighthouseRows = parseLighthouseRows(rows);
      await saveLighthouseData(hotelUid, getLocalIsoDate(), lighthouseRows);
      setImportMessage({ type: "success", text: `${lighthouseRows.length} datums zijn succesvol geïmporteerd.` });
    } catch (error) {
      console.error("Lighthouse-import mislukt:", error);
      setImportMessage({ type: "error", text: error?.message || "Het Excel-bestand kon niet geïmporteerd worden." });
    } finally {
      setImporting(false);
    }
  };

  return <div className="min-h-screen bg-gray-50 text-gray-900"><HeaderBar today={today} onLogout={handleLogout} /><PageContainer className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-sm uppercase tracking-wide text-gray-500">Revenue / Group Quotes</p><h1 className="text-3xl font-semibold">Group Quote Settings</h1></div><div className="flex flex-wrap justify-end gap-3"><input ref={fileInputRef} type="file" accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange={handleLighthouseImport} className="hidden" /><button type="button" disabled={importing || !hotelUid} onClick={() => fileInputRef.current?.click()} className="inline-flex items-center gap-2 rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white hover:bg-[#961a1a] disabled:cursor-not-allowed disabled:bg-gray-400"><Upload className="h-4 w-4" /> {importing ? "Importing..." : "Upload Lighthouse Data"}</button><button type="button" onClick={() => navigate("/revenue/group-quotes")} className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold hover:bg-gray-100"><ArrowLeft className="h-4 w-4" /> Back to overview</button></div></div>
    {importMessage && <div role="status" className={`rounded-lg border px-4 py-3 text-sm font-medium ${importMessage.type === "success" ? "border-green-200 bg-green-50 text-green-800" : "border-red-200 bg-red-50 text-red-800"}`}>{importMessage.text}</div>}
    <Card>{loading ? <p>Loading settings...</p> : <form onSubmit={handleSubmit} className="space-y-5"><div className="grid max-w-3xl gap-4 sm:grid-cols-2"><label className="block text-sm font-semibold">Inflation %<input required min="0" step="0.01" type="number" value={inflationPercentage} onChange={(event) => setInflationPercentage(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal" /></label><label className="block text-sm font-semibold">Displacement Threshold %<input required min="0" max="100" step="0.01" type="number" value={displacementThresholdPercentage} onChange={(event) => setDisplacementThresholdPercentage(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal" /></label><label className="block text-sm font-semibold">Max Historical Group Share %<input required min="0" max="100" step="0.01" type="number" value={maxHistoricalGroupSharePercentage} onChange={(event) => setMaxHistoricalGroupSharePercentage(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal" /></label><label className="block text-sm font-semibold">Room VAT %<input required min="0" step="0.01" type="number" value={roomVatPercentage} onChange={(event) => setRoomVatPercentage(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal" /></label><label className="block text-sm font-semibold">Breakfast Allocation (€)<input required min="0" step="0.01" type="number" value={breakfastAllocation} onChange={(event) => setBreakfastAllocation(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal" /></label></div><div><button disabled={saving} className="rounded-lg bg-[#b41f1f] px-5 py-2 font-semibold text-white disabled:bg-gray-400">{saving ? "Saving..." : "Save Settings"}</button></div></form>}</Card>
  </PageContainer></div>;
}
