import React from "react";
import { Card } from "../layout/Card";
import { formatHotelStayDate } from "../../utils/hotelStayDates";

const money = (value) => `€${Number(value || 0).toFixed(2)}`;

export default function QuoteInputSummary({ quote, mealBasis, onEdit }) {
  const nights = quote?.roomsByDate?.length || 0;
  const requested = quote?.roomsByDate?.reduce((sum, night) => sum + Number(night.rooms || 0), 0) || 0;
  const bqt = quote?.roomsByDate?.reduce((sum, night) => sum + Number(night.bqtRevenue || 0), 0) || 0;
  return <Card className="border border-gray-200 bg-white shadow-sm" aria-label="Compact Quote Summary"><div className="flex flex-wrap items-center justify-between gap-4"><div><p className="text-lg font-semibold">{quote?.name || "Untitled quote"}</p><p className="text-sm text-gray-600">Arrival {formatHotelStayDate(quote?.startDate)} → Check-out {formatHotelStayDate(quote?.endDate)}</p></div><dl className="flex flex-wrap gap-x-7 gap-y-2 text-sm">{[["Nights", nights], ["Requested RN", Math.round(requested).toLocaleString()], ["Meal basis", mealBasis], ["Total BQT revenue", money(bqt)]].map(([label,value])=><div key={label}><dt className="text-xs uppercase text-gray-500">{label}</dt><dd className="font-semibold">{value}</dd>{label === "Meal basis" && mealBasis === "MIXED" && <p className="text-xs text-gray-500">Varies by stay date</p>}</div>)}</dl><button type="button" onClick={onEdit} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold hover:bg-gray-100">Edit inputs</button></div></Card>;
}
