import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Pencil, Trash2 } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import DataListTable from "../shared/DataListTable";
import ConfirmModal from "../layout/ConfirmModal";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { usePermission } from "../../hooks/usePermission";
import { deleteQuote, getQuote } from "../../services/firebaseQuotes";

export default function GroupQuoteDetailPage() {
  const navigate = useNavigate();
  const { quoteId } = useParams();
  const { hotelUid } = useHotelContext();
  const canEdit = usePermission("groupquotes", "update");
  const canDelete = usePermission("groupquotes", "delete");
  const [quote, setQuote] = useState(null);
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const today = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);
  const handleLogout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };

  useEffect(() => {
    if (!hotelUid || !quoteId) return;
    setLoading(true);
    getQuote(hotelUid, quoteId).then((result) => { setQuote(result); setLoading(false); });
  }, [hotelUid, quoteId]);

  const currency = (value) => `€${Number(value || 0).toFixed(2)}`;
  const columns = [
    { key: "date", label: "Date" },
    { key: "rooms", label: "Rooms", sortValue: (row) => Number(row.rooms || 0) },
    { key: "bqtRevenue", label: "BQT Revenue", sortValue: (row) => Number(row.bqtRevenue || 0), render: (row) => currency(row.bqtRevenue) },
  ];

  return <div className="min-h-screen bg-gray-50 text-gray-900">
    <HeaderBar today={today} onLogout={handleLogout} />
    <PageContainer className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div><p className="text-sm uppercase tracking-wide text-gray-500">Revenue / Group Quotes</p><h1 className="text-3xl font-semibold">Group Quote Detail</h1></div>
        <div className="flex gap-2">
          <button type="button" onClick={() => navigate("/revenue/group-quotes")} className="rounded-lg border border-gray-300 bg-white p-2 hover:bg-gray-100" title="Back to Group Quotes"><ArrowLeft className="h-5 w-5" /></button>
          {canEdit && <button type="button" onClick={() => navigate(`/revenue/group-quotes/${quoteId}/edit`)} className="rounded-lg bg-[#b41f1f] p-2 text-white hover:bg-[#961919]" title="Edit Group Quote" aria-label="Edit Group Quote"><Pencil className="h-5 w-5" /></button>}
          {canDelete && <button type="button" onClick={() => setConfirmDelete(true)} className="rounded-lg border border-red-200 bg-white p-2 text-red-700 hover:bg-red-50" title="Delete Group Quote" aria-label="Delete Group Quote"><Trash2 className="h-5 w-5" /></button>}
        </div>
      </div>
      {loading ? <p className="text-gray-600">Loading quote...</p> : !quote ? <Card><p>Group quote not found.</p></Card> : <>
        <Card className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <div><p className="text-xs uppercase text-gray-500">Name</p><p className="font-semibold">{quote.name || "-"}</p></div>
          <div><p className="text-xs uppercase text-gray-500">Request Date</p><p className="font-semibold">{quote.requestDate || "-"}</p></div>
          <div><p className="text-xs uppercase text-gray-500">Stay</p><p className="font-semibold">{quote.startDate} – {quote.endDate}</p></div>
          <div><p className="text-xs uppercase text-gray-500">Breakfast Pax</p><p className="font-semibold">{Number(quote.breakfastPax || 0)}</p></div>
        </Card>
        <div><h2 className="mb-3 text-xl font-semibold">Daily details</h2><DataListTable columns={columns} rows={(quote.roomsByDate || []).map((row) => ({ ...row, id: row.date }))} emptyMessage="No daily details found." /></div>
      </>}
    </PageContainer>
    <ConfirmModal open={confirmDelete} title="Delete Group Quote" message={`Are you sure you want to delete ${quote?.name || "this Group Quote"}?`} onCancel={() => setConfirmDelete(false)} onConfirm={async () => { await deleteQuote(hotelUid, quoteId); navigate("/revenue/group-quotes"); }} />
  </div>;
}
