import React, { useMemo, useState } from "react";
import { saveCompetitorGroupObservation } from "../../services/firebaseQuotes";

const options = (values) => values.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>);

export default function CompetitorQuoteForm({ hotelUid, quote, competitors, onSaved }) {
  const enabled = competitors.filter((item) => item.groupIntelligenceEnabled);
  const [competitorId, setCompetitorId] = useState(enabled[0]?.id || "");
  const [rate, setRate] = useState("");
  const [mealBasis, setMealBasis] = useState("UNKNOWN");
  const [occupancyBasis, setOccupancyBasis] = useState("UNKNOWN");
  const [sourceConfidence, setSourceConfidence] = useState("MEDIUM");
  const [sourceType, setSourceType] = useState("LOST_GROUP");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const rooms = quote.roomsByDate || [];
  const publicRate = useMemo(() => {
    const weighted = quote.marketContextSnapshot?.stayDates?.map((date) => ({
      value: date.competitors?.find((item) => item.competitorId === competitorId)?.publicRateInclVat ?? null,
      rooms: Number(date.requestedRooms) || 0,
    })).filter((item) => item.value !== null && item.rooms > 0) || [];
    const denominator = weighted.reduce((sum, item) => sum + item.rooms, 0);
    return denominator ? weighted.reduce((sum, item) => sum + item.value * item.rooms, 0) / denominator : null;
  }, [competitorId, quote.marketContextSnapshot, rooms]);
  if (!enabled.length) return <p className="text-sm text-gray-600">No competitors are enabled for group intelligence.</p>;
  const submit = async (event) => {
    event.preventDefault(); setSaving(true);
    const competitor = enabled.find((item) => item.id === competitorId);
    await saveCompetitorGroupObservation(hotelUid, {
      competitorId, competitorName: competitor?.displayName || competitorId, observedAt: new Date(), sourceType,
      sourceQuoteId: quote.id, stayStartDate: quote.startDate, stayEndDate: quote.endDate, roomsByDate: rooms,
      requestedRoomsTotal: rooms.reduce((sum, item) => sum + Number(item.rooms || 0), 0),
      requestedRoomNights: rooms.reduce((sum, item) => sum + Number(item.rooms || 0), 0), segment: quote.segment || null,
      competitorQuotedRateInclVat: Number(rate), mealBasis, occupancyBasis, publicRateAtObservationInclVat: publicRate,
      publicRateMealBasis: "UNKNOWN", sourceConfidence, notes,
    });
    setSaving(false); onSaved?.();
  };
  return <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
    <label className="text-sm font-semibold">Competitor<select value={competitorId} onChange={(e) => setCompetitorId(e.target.value)} className="mt-1 w-full rounded border px-3 py-2 font-normal">{enabled.map((item) => <option value={item.id} key={item.id}>{item.displayName}</option>)}</select></label>
    <label className="text-sm font-semibold">Quoted Rate incl. VAT<input required min="0" step="0.01" type="number" value={rate} onChange={(e) => setRate(e.target.value)} className="mt-1 w-full rounded border px-3 py-2 font-normal" /></label>
    <label className="text-sm font-semibold">Source Type<select value={sourceType} onChange={(e) => setSourceType(e.target.value)} className="mt-1 w-full rounded border px-3 py-2 font-normal">{options(["LOST_GROUP", "WON_GROUP", "CLIENT_FEEDBACK", "SALES_INTELLIGENCE", "MANUAL_OBSERVATION", "OTHER"])}</select></label>
    <label className="text-sm font-semibold">Meal Basis<select value={mealBasis} onChange={(e) => setMealBasis(e.target.value)} className="mt-1 w-full rounded border px-3 py-2 font-normal">{options(["RO", "BB", "HB", "FB", "OTHER", "UNKNOWN"])}</select></label>
    <label className="text-sm font-semibold">Occupancy Basis<select value={occupancyBasis} onChange={(e) => setOccupancyBasis(e.target.value)} className="mt-1 w-full rounded border px-3 py-2 font-normal">{options(["SINGLE", "DOUBLE", "MIXED", "UNKNOWN"])}</select></label>
    <label className="text-sm font-semibold">Source Confidence<select value={sourceConfidence} onChange={(e) => setSourceConfidence(e.target.value)} className="mt-1 w-full rounded border px-3 py-2 font-normal">{options(["HIGH", "MEDIUM", "LOW"])}</select></label>
    <label className="text-sm font-semibold sm:col-span-2 lg:col-span-3">Notes<textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1 w-full rounded border px-3 py-2 font-normal" /></label>
    <div><button disabled={saving} className="rounded bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white disabled:bg-gray-400">{saving ? "Saving…" : "Record Competitor Quote"}</button></div>
  </form>;
}
