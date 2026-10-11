import React, { useCallback, useState } from "react";
import { ArrowLeft, Pencil, Trash2 } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import PageShell from "../layout/PageShell";
import AsyncError from "../shared/AsyncError";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { Card } from "../layout/Card";
import DataListTable from "../shared/DataListTable";
import ConfirmModal from "../layout/ConfirmModal";
import { useHotelContext } from "../../contexts/HotelContext";
import { usePermission } from "../../hooks/usePermission";
import { deleteQuote, getCompsetConfiguration, getCompetitorGroupObservationCounts, getQuote, SAVED_ANALYSIS_STALE_WARNING } from "../../services/firebaseQuotes";
import MarketPricingContext from "./MarketPricingContext";
import CompetitorQuoteForm from "./CompetitorQuoteForm";
import PricingGuidance from "./PricingGuidance";
import QuoteOutcomeForm from "./QuoteOutcomeForm";
import { getQuoteStayDates } from "../../utils/quoteDates";
import { formatHotelStayDate } from "../../utils/hotelStayDates";

export default function GroupQuoteDetailPage() {
  const navigate = useNavigate();
  const { quoteId } = useParams();
  const { hotelUid } = useHotelContext();
  const canEdit = usePermission("groupquotes", "update");
  const canDelete = usePermission("groupquotes", "delete");
  const canReadIntelligence = usePermission("commercialintelligence", "read");
  const canCreateIntelligence = usePermission("commercialintelligence", "create");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [observationMessage, setObservationMessage] = useState("");
  const [mutationError, setMutationError] = useState(null);
  const loadQuote = useCallback(async () => {
    const [quote, compset, observationCounts] = await Promise.all([getQuote(hotelUid, quoteId), getCompsetConfiguration(hotelUid), canReadIntelligence ? getCompetitorGroupObservationCounts(hotelUid) : Promise.resolve({})]);
    return { quote, competitors: compset.competitors, observationCounts };
  }, [hotelUid, quoteId, canReadIntelligence]);
  const query = useScopedAsync({ scopeKey: `${hotelUid}:${quoteId}`, enabled: Boolean(hotelUid && quoteId), load: loadQuote });
  const { quote = null, competitors = [], observationCounts = {} } = query.data || {};
  const loading = query.loading;

  const stayNights = quote ? getQuoteStayDates(quote) : [];
  const currency = (value) => value === null || value === undefined || String(value).trim() === "" || !Number.isFinite(Number(value)) ? "Unknown" : `€${Number(value).toFixed(2)}`;
  const breakfastValues = ["group-quote-v2", "group-quote-v3-meal-basis"].includes(quote?.quoteInputSchemaVersion) ? (quote.roomsByDate || []).map((row) => row.breakfastPax) : [quote?.breakfastPax];
  const breakfastSummary = breakfastValues.some((value) => value === null || value === undefined || String(value).trim() === "" || !Number.isFinite(Number(value))) ? "Unknown" : breakfastValues.reduce((sum, value) => sum + Number(value), 0);
  const columns = [
    { key: "date", label: "Date", render: (row) => formatHotelStayDate(row.date) },
    { key: "rooms", label: "Rooms", sortValue: (row) => Number(row.rooms || 0) },
    { key: "mealBasis", label: "Meal Basis", render: (row) => row.mealBasis || "Unknown" },
    { key: "breakfastPax", label: "Breakfast Pax", render: (row) => row.breakfastPax ?? "Legacy unknown" },
    { key: "bqtRevenue", label: "BQT Revenue", sortValue: (row) => Number(row.bqtRevenue || 0), render: (row) => currency(row.bqtRevenue) },
  ];

  return <PageShell afterContent={<ConfirmModal open={confirmDelete} title="Delete Group Quote" message={`Are you sure you want to delete ${quote?.name || "this Group Quote"}?`} onCancel={() => setConfirmDelete(false)} onConfirm={async () => { try { await deleteQuote(hotelUid, quoteId); navigate("/revenue/group-quotes"); } catch (error) { setConfirmDelete(false); setMutationError(error); } }} />}>
    <AsyncError error={query.error} onRetry={query.retry} label="Could not load this quote." />
    <AsyncError error={mutationError} label="Could not delete this quote. Please try again." />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><p className="text-sm uppercase tracking-wide text-gray-500">Revenue / Group Quotes</p><h1 className="text-3xl font-semibold">Group Quote Detail</h1></div>
        <div className="flex gap-2">
          <button type="button" onClick={() => navigate("/revenue/group-quotes")} className="rounded-lg border border-gray-300 bg-white p-2 hover:bg-gray-100" title="Back to Group Quotes"><ArrowLeft className="h-5 w-5" /></button>
          {canEdit && <button type="button" onClick={() => navigate(`/revenue/group-quotes/${quoteId}/edit`)} className="rounded-lg bg-brand-800 p-2 text-white hover:bg-brand-950" title="Edit Group Quote" aria-label="Edit Group Quote"><Pencil className="h-5 w-5" /></button>}
          {canDelete && <button type="button" onClick={() => setConfirmDelete(true)} className="rounded-lg border border-red-200 bg-white p-2 text-red-700 hover:bg-red-50" title="Delete Group Quote" aria-label="Delete Group Quote"><Trash2 className="h-5 w-5" /></button>}
        </div>
      </div>
      {loading ? <p className="text-gray-600">Loading quote...</p> : query.error ? null : !quote ? <Card><p>Group quote not found.</p></Card> : <>
        {quote.analysisStatus === "UNAVAILABLE" && <Card className="border border-amber-300 bg-amber-50 text-amber-900"><strong>Draft analysis unavailable.</strong> {quote.analysisUnavailableReason || "Required data was unavailable when this draft was saved."}</Card>}
        {quote.analysisStatus === "STALE" && <Card data-warning-code={SAVED_ANALYSIS_STALE_WARNING.code} className="border border-amber-300 bg-amber-50 text-amber-900"><strong>Saved analysis is stale.</strong> Quote inputs changed after the forecast was created; saved forecast values must not be treated as current.</Card>}
        <Card className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <div><p className="text-xs uppercase text-gray-500">Name</p><p className="font-semibold">{quote.name || "-"}</p></div>
          <div><p className="text-xs uppercase text-gray-500">Request Date</p><p className="font-semibold">{quote.requestDate || "-"}</p></div>
          <div><p className="text-xs uppercase text-gray-500">{quote.dateRangeSemantics === "CHECKOUT_EXCLUSIVE" ? "Arrival / Check-out" : "Legacy inclusive stay"}</p><p className="font-semibold">{formatHotelStayDate(quote.startDate)} – {formatHotelStayDate(quote.endDate)}</p><p className="text-sm text-gray-500">{stayNights.length} stay nights</p></div><div><p className="text-xs uppercase text-gray-500">Breakfast Pax</p><p className="font-semibold">{["group-quote-v2", "group-quote-v3-meal-basis"].includes(quote.quoteInputSchemaVersion) ? breakfastSummary : `${breakfastSummary} (legacy total)`}</p></div>
        </Card>
        {quote.physicalFeasibility && <Card className={quote.physicalFeasibility.status === "PHYSICALLY_FEASIBLE" ? "border-green-200 bg-green-50" : "border-red-300 bg-red-50"}><p className="text-xs font-bold uppercase text-gray-600">Frozen physical capacity analysis</p><h2 className="text-xl font-bold">{quote.physicalFeasibility.status === "PHYSICALLY_FEASIBLE" ? "FEASIBLE" : quote.physicalFeasibility.status === "PHYSICAL_CAPACITY_UNAVAILABLE" ? "UNKNOWN" : "NOT FEASIBLE"}</h2><dl className="mt-3 grid gap-3 sm:grid-cols-3"><div><dt>Requested RN</dt><dd className="font-bold">{quote.physicalFeasibility.requestedRoomNights}</dd></div><div><dt>Physically feasible requested RN</dt><dd className="font-bold">{quote.physicalFeasibility.physicallyFeasibleRequestedRoomNights}</dd></div><div><dt>Capacity shortfall RN</dt><dd className="font-bold">{quote.physicalFeasibility.totalCapacityShortfallRoomNights}</dd></div></dl>{quote.physicalFeasibility.perDate?.filter((night) => !night.feasible).map((night) => <p className="mt-2 text-sm" key={night.date}><strong>{formatHotelStayDate(night.date)}</strong>: {night.requestedRooms} requested · {night.remainingPhysicalCapacity} currently available · shortfall {night.capacityShortfallRooms}</p>)}</Card>}
        {quote.analysisStatus === "CURRENT" && <PricingGuidance guidance={quote.pricingGuidanceSnapshot} ownPublicRateInclVat={quote.marketContextSnapshot?.groupStaySummary?.weightedOwnPublicRateInclVat ?? null} />}
        {canEdit && <Card><h2 className="text-xl font-semibold">Update Outcome</h2><p className="text-sm text-gray-600">Record the actual commercial decision and quoted-rate history separately from the immutable analysis.</p><QuoteOutcomeForm key={`${hotelUid}:${quoteId}`} hotelUid={hotelUid} quote={quote} competitors={competitors} onSaved={query.retry} /></Card>}
        <MarketPricingContext snapshot={quote.marketContextSnapshot} economicFloorInclVat={quote.analysisContributionSnapshot?.economicFloorRateInclVat ?? null} stale={quote.analysisStatus === "STALE" || quote.analysisStatus === "UNAVAILABLE"} />
        {(canReadIntelligence || canCreateIntelligence) && <Card><h2 className="text-xl font-semibold">Competitor Group Intelligence</h2><p className="mt-1 text-sm text-gray-600">Record real observed competitor group pricing. Meal and occupancy basis are retained; no rate prediction is produced.</p><div className="my-4 flex flex-wrap gap-2">{competitors.filter((item) => item.groupIntelligenceEnabled).map((item) => <span key={item.id} className="rounded-full bg-gray-100 px-3 py-1 text-xs">{item.displayName}: {observationCounts[item.id] || 0} observed</span>)}</div>{Object.keys(observationCounts).length === 0 && <p className="mb-4 text-sm italic text-gray-500">No competitor group-rate observations available.</p>}{canCreateIntelligence && <CompetitorQuoteForm key={`${hotelUid}:${quoteId}`} hotelUid={hotelUid} quote={quote} competitors={competitors} onSaved={async () => { await query.retry(); setObservationMessage("Competitor quote recorded without changing the Economic Floor."); }} />}{observationMessage && <p role="status" className="mt-3 text-sm font-semibold text-green-700">{observationMessage}</p>}</Card>}
                <div><h2 className="mb-3 text-xl font-semibold">Daily details</h2><DataListTable columns={columns} rows={(quote.roomsByDate || []).map((row) => ({ ...row, id: row.date }))} emptyMessage="No daily details found." /></div>
      </>}

  </PageShell>;
}
