import React, { useCallback, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import PageShell from "../layout/PageShell";
import AsyncError from "../shared/AsyncError";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { Card } from "../layout/Card";
import GroupQuoteFormFields from "./GroupQuoteFormFields";
import { useHotelContext } from "../../contexts/HotelContext";
import { getGroupQuoteSettings, getQuote, hasAnalysisAffectingChanges, updateQuote } from "../../services/firebaseQuotes";

export default function GroupQuoteEditPage() {
  const navigate = useNavigate();
  const { quoteId } = useParams();
  const { hotelUid } = useHotelContext();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const loadQuote = useCallback(async () => {
    const [quote, quoteSettings] = await Promise.all([getQuote(hotelUid, quoteId), getGroupQuoteSettings(hotelUid)]);
    return { quote, quoteSettings };
  }, [hotelUid, quoteId]);
  const query = useScopedAsync({ scopeKey: `${hotelUid}:${quoteId}`, enabled: Boolean(hotelUid && quoteId), load: loadQuote });
  const { quote = null, quoteSettings = {} } = query.data || {};
  const loading = query.loading;

  const handleUpdate = async (payload) => {
    setSaving(true); setSaveError(null);
    try {
      const analysisIsStale = hasAnalysisAffectingChanges(quote, payload);
      await updateQuote(hotelUid, quoteId, {
        ...payload,
        ...(analysisIsStale ? { analysisStatus: "STALE", analysisStaleReason: "QUOTE_INPUTS_CHANGED" } : {}),
      });
      navigate(`/revenue/group-quotes/${quoteId}`);
    } catch (error) { setSaveError(error); } finally { setSaving(false); }
  };

  return <PageShell className="space-y-6 pb-10">
    <AsyncError error={query.error} onRetry={query.retry} label="Could not load this quote." />
    <AsyncError error={saveError} label="Could not save this quote. Your inputs are retained; try saving again." />
      <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm uppercase tracking-wide text-gray-500">Revenue / Group Quotes</p><h1 className="text-3xl font-semibold">Edit Group Quote</h1></div><button type="button" onClick={() => navigate(`/revenue/group-quotes/${quoteId}`)} className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold hover:bg-gray-100"><ArrowLeft className="h-4 w-4" /> Back to detail</button></div>
      {loading ? <p className="text-gray-600">Loading quote...</p> : query.error ? null : !quote ? <Card>Group quote not found.</Card> : <Card><GroupQuoteFormFields key={`${hotelUid}:${quoteId}`} initialQuote={quote} defaultGroupCommissionPercentage={quoteSettings.defaultGroupCommissionPercentage} defaultGroupMealBasis={quoteSettings.defaultGroupMealBasis || "RO"} onSubmit={handleUpdate} saving={saving} submitLabel="Save Quote" /></Card>}
  </PageShell>;
}
