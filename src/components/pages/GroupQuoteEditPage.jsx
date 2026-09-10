import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import GroupQuoteFormFields from "./GroupQuoteFormFields";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getQuote, updateQuote } from "../../services/firebaseQuotes";

export default function GroupQuoteEditPage() {
  const navigate = useNavigate();
  const { quoteId } = useParams();
  const { hotelUid } = useHotelContext();
  const [quote, setQuote] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const today = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);
  const handleLogout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };

  useEffect(() => {
    if (!hotelUid || !quoteId) return;
    getQuote(hotelUid, quoteId).then((result) => { setQuote(result); setLoading(false); });
  }, [hotelUid, quoteId]);

  const handleUpdate = async (payload) => {
    setSaving(true);
    try {
      await updateQuote(hotelUid, quoteId, payload);
      navigate(`/revenue/group-quotes/${quoteId}`);
    } finally { setSaving(false); }
  };

  return <div className="min-h-screen bg-gray-50 text-gray-900">
    <HeaderBar today={today} onLogout={handleLogout} />
    <PageContainer className="space-y-6 pb-10">
      <div className="flex items-center justify-between gap-3"><div><p className="text-sm uppercase tracking-wide text-gray-500">Revenue / Group Quotes</p><h1 className="text-3xl font-semibold">Edit Group Quote</h1></div><button type="button" onClick={() => navigate(`/revenue/group-quotes/${quoteId}`)} className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold hover:bg-gray-100"><ArrowLeft className="h-4 w-4" /> Back to detail</button></div>
      {loading ? <p className="text-gray-600">Loading quote...</p> : !quote ? <Card>Group quote not found.</Card> : <Card><GroupQuoteFormFields initialQuote={quote} onSubmit={handleUpdate} saving={saving} submitLabel="Save Quote" /></Card>}
    </PageContainer>
  </div>;
}
