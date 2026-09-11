import React, { useEffect, useMemo, useState } from "react";
import { getInclusiveQuoteDates } from "../../utils/quoteDates";

export default function GroupQuoteFormFields({ initialQuote, onSubmit, saving, submitLabel, children }) {
  const [name, setName] = useState("");
  const [requestDate, setRequestDate] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [dailyValues, setDailyValues] = useState({});
  const [breakfastPax, setBreakfastPax] = useState("");
  const [error, setError] = useState("");
  const dates = useMemo(() => getInclusiveQuoteDates(startDate, endDate), [startDate, endDate]);

  useEffect(() => {
    if (!initialQuote) return;
    setName(initialQuote.name || "");
    setRequestDate(initialQuote.requestDate || "");
    setStartDate(initialQuote.startDate || "");
    setEndDate(initialQuote.endDate || "");
    setBreakfastPax(initialQuote.breakfastPax ?? "");
    setDailyValues(Object.fromEntries((initialQuote.roomsByDate || []).map((item) => [item.date, {
      rooms: item.rooms ?? "",
      bqtRevenue: item.bqtRevenue ?? "",
    }])));
  }, [initialQuote]);

  const updateDailyValue = (date, key, value) => {
    setDailyValues((current) => ({
      ...current,
      [date]: { ...current[date], [key]: value },
    }));
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    setError("");
    if (!dates.length) {
      setError("End date must be on or after the start date.");
      return;
    }
    onSubmit({
      name: name.trim(),
      requestDate,
      startDate,
      endDate,
      roomsByDate: dates.map((date) => ({
        date,
        rooms: Number(dailyValues[date]?.rooms || 0),
        bqtRevenue: Number(dailyValues[date]?.bqtRevenue || 0),
      })),
      breakfastPax: Number(breakfastPax || 0),
    });
  };

  const inputClassName = "mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal";

  return (
    <form className="space-y-6" onSubmit={handleSubmit}>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-semibold">Name
          <input required type="text" autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} className={inputClassName} />
        </label>
        <label className="text-sm font-semibold">Request Date
          <input required type="date" value={requestDate} onChange={(event) => setRequestDate(event.target.value)} className={inputClassName} />
        </label>
        <label className="text-sm font-semibold">Start Date
          <input required type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} className={inputClassName} />
        </label>
        <label className="text-sm font-semibold">End Date
          <input required type="date" min={startDate || undefined} value={endDate} onChange={(event) => setEndDate(event.target.value)} className={inputClassName} />
        </label>
      </div>

      {dates.length > 0 && (
        <fieldset className="space-y-3">
          <legend className="text-base font-semibold">Rooms and BQT revenue per date</legend>
          <div className="overflow-hidden rounded-lg border border-gray-200">
            {dates.map((date) => (
              <div key={date} className="grid gap-3 border-b border-gray-200 bg-gray-50 p-3 last:border-b-0 sm:grid-cols-[1fr_180px_180px] sm:items-end">
                <div className="pb-2 text-sm font-semibold sm:pb-0">
                  {new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
                </div>
                <label className="text-xs font-semibold text-gray-600">Rooms
                  <input required min="0" step="1" type="number" value={dailyValues[date]?.rooms ?? ""} onChange={(event) => updateDailyValue(date, "rooms", event.target.value)} className={inputClassName} />
                </label>
                <label className="text-xs font-semibold text-gray-600">BQT Revenue (€)
                  <input required min="0" step="0.01" type="number" value={dailyValues[date]?.bqtRevenue ?? ""} onChange={(event) => updateDailyValue(date, "bqtRevenue", event.target.value)} className={inputClassName} />
                </label>
              </div>
            ))}
          </div>
        </fieldset>
      )}

      <div className="grid items-end gap-4 sm:grid-cols-2">
        <label className="text-sm font-semibold">Breakfast Pax
          <input required min="0" step="1" type="number" value={breakfastPax} onChange={(event) => setBreakfastPax(event.target.value)} className={inputClassName} />
        </label>
      </div>
      {children}
      {error && <p role="alert" className="text-sm font-medium text-red-700">{error}</p>}
      <div className="flex justify-end">
        <button disabled={saving} type="submit" className="rounded-lg bg-[#b41f1f] px-5 py-2 font-semibold text-white shadow hover:bg-[#961919] disabled:bg-gray-400">
          {saving ? "Saving quote..." : submitLabel}
        </button>
      </div>
    </form>
  );
}
