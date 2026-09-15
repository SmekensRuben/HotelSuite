import React, { useEffect, useMemo, useState } from "react";
import { DATE_RANGE_SEMANTICS, getCheckoutExclusiveStayDates, getInclusiveQuoteDates } from "../../utils/quoteDates";

export default function GroupQuoteFormFields({ initialQuote, defaultGroupCommissionPercentage, onSubmit, saving, submitLabel, children }) {
  const legacyQuote = Boolean(initialQuote && initialQuote.dateRangeSemantics !== DATE_RANGE_SEMANTICS.CHECKOUT_EXCLUSIVE);
  const [name, setName] = useState("");
  const [requestDate, setRequestDate] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [groupSegment, setGroupSegment] = useState("UNKNOWN");
  const [dailyValues, setDailyValues] = useState({});
  const [groupCommissionPercentage, setGroupCommissionPercentage] = useState("");
  const [error, setError] = useState("");
  const dates = useMemo(() => legacyQuote ? getInclusiveQuoteDates(startDate, endDate) : getCheckoutExclusiveStayDates(startDate, endDate), [startDate, endDate, legacyQuote]);

  useEffect(() => {
    if (!initialQuote) return;
    setName(initialQuote.name || ""); setRequestDate(initialQuote.requestDate || ""); setStartDate(initialQuote.startDate || ""); setEndDate(initialQuote.endDate || ""); setGroupSegment(initialQuote.groupSegment || "UNKNOWN");
    setGroupCommissionPercentage(initialQuote.groupCommissionPercentage ?? defaultGroupCommissionPercentage ?? "");
    setDailyValues(Object.fromEntries((initialQuote.roomsByDate || []).map((item) => [item.date, { rooms: item.rooms ?? "", breakfastPax: item.breakfastPax ?? "", bqtRevenue: item.bqtRevenue ?? "" }])));
  }, [initialQuote, defaultGroupCommissionPercentage]);
  useEffect(() => { if (!initialQuote && groupCommissionPercentage === "" && defaultGroupCommissionPercentage !== undefined) setGroupCommissionPercentage(defaultGroupCommissionPercentage); }, [defaultGroupCommissionPercentage, groupCommissionPercentage, initialQuote]);
  const updateDailyValue = (date, key, value) => setDailyValues((current) => ({ ...current, [date]: { ...current[date], [key]: value } }));
  const handleSubmit = (event) => {
    event.preventDefault(); setError("");
    if (!dates.length) { setError(legacyQuote ? "End date must be on or after the start date." : "Check-out Date must be after Arrival Date."); return; }
    onSubmit({ name: name.trim(), requestDate, startDate, endDate, groupSegment, ...(legacyQuote ? {} : { dateRangeSemantics: DATE_RANGE_SEMANTICS.CHECKOUT_EXCLUSIVE, quoteInputSchemaVersion: "group-quote-v2" }), roomsByDate: dates.map((date) => ({ date, rooms: Number(dailyValues[date]?.rooms || 0), ...(legacyQuote ? {} : { breakfastPax: Number(dailyValues[date]?.breakfastPax || 0) }), bqtRevenue: Number(dailyValues[date]?.bqtRevenue || 0) })), ...(legacyQuote ? { breakfastPax: Number(initialQuote.breakfastPax || 0) } : {}), groupCommissionPercentage: Number(groupCommissionPercentage) });
  };
  const cls = "mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal";
  return <form className="space-y-6" onSubmit={handleSubmit}>
    <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-semibold">Name<input required value={name} onChange={(e) => setName(e.target.value)} className={cls} /></label><label className="text-sm font-semibold">Request Date<input required type="date" value={requestDate} onChange={(e) => setRequestDate(e.target.value)} className={cls} /></label><label className="text-sm font-semibold">{legacyQuote ? "Start Date (legacy)" : "Arrival Date"}<input required type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={cls} /></label><label className="text-sm font-semibold">{legacyQuote ? "End Date (legacy inclusive)" : "Check-out Date"}<input required type="date" min={startDate || undefined} value={endDate} onChange={(e) => setEndDate(e.target.value)} className={cls} /></label><label className="text-sm font-semibold">Group Segment (optional)<select value={groupSegment} onChange={(e) => setGroupSegment(e.target.value)} className={cls}>{["UNKNOWN","CORPORATE_MICE","ASSOCIATION_CONFERENCE","LEISURE_GROUP","CREW_CONTRACT","SOCIAL","SPORTS","OTHER"].map((x)=><option key={x}>{x}</option>)}</select></label></div>
    {dates.length > 0 && <fieldset className="space-y-3"><legend className="text-base font-semibold">Stay Nights</legend><div className="overflow-hidden rounded-lg border">{dates.map((date) => <div key={date} className={`grid gap-3 border-b bg-gray-50 p-3 last:border-0 ${legacyQuote ? "sm:grid-cols-[1fr_180px_180px]" : "sm:grid-cols-[1fr_150px_170px_180px]"} sm:items-end`}><div className="pb-2 text-sm font-semibold">{date}</div><label className="text-xs font-semibold">Rooms<input required min="0" step="1" type="number" value={dailyValues[date]?.rooms ?? ""} onChange={(e) => updateDailyValue(date,"rooms",e.target.value)} className={cls} /></label>{!legacyQuote && <label className="text-xs font-semibold">Breakfast Pax<input required min="0" step="1" type="number" value={dailyValues[date]?.breakfastPax ?? ""} onChange={(e) => updateDailyValue(date,"breakfastPax",e.target.value)} className={cls} /></label>}<label className="text-xs font-semibold">BQT Revenue (€)<input required min="0" step=".01" type="number" value={dailyValues[date]?.bqtRevenue ?? ""} onChange={(e) => updateDailyValue(date,"bqtRevenue",e.target.value)} className={cls} /></label></div>)}</div><p className="text-xs text-gray-500">Breakfast Pax belongs to the stay night and is normally consumed the following morning. Check-out is not a room night.</p></fieldset>}
    {legacyQuote && <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm"><strong>Legacy total Breakfast Pax:</strong> {Number(initialQuote.breakfastPax || 0)}. Its nightly distribution is unknown and has not been inferred.</div>}
    <label className="block max-w-sm text-sm font-semibold">Group Commission %<input required min="0" max="99.99" step=".01" type="number" value={groupCommissionPercentage} onChange={(e) => setGroupCommissionPercentage(e.target.value)} className={cls} /></label>{children}{error && <p role="alert" className="text-sm font-medium text-red-700">{error}</p>}<div className="flex justify-end"><button disabled={saving} className="rounded-lg bg-[#b41f1f] px-5 py-2 font-semibold text-white disabled:bg-gray-400">{saving ? "Saving quote..." : submitLabel}</button></div>
  </form>;
}
