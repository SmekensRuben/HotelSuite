import React, { useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { addQuote } from "../../services/firebaseQuotes";
import { getInclusiveQuoteDates } from "../../utils/quoteDates";

export default function GroupQuoteCreatePage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [roomCounts, setRoomCounts] = useState({});
  const [pricePerNight, setPricePerNight] = useState("");
  const [breakfastIncluded, setBreakfastIncluded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dates = useMemo(() => getInclusiveQuoteDates(startDate, endDate), [startDate, endDate]);
  const today = useMemo(() => new Date().toLocaleDateString(undefined, {
    weekday: "long", month: "long", day: "numeric",
  }), []);

  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    if (!dates.length) {
      setError("End date must be on or after the start date.");
      return;
    }

    setSaving(true);
    try {
      await addQuote(hotelUid, {
        startDate,
        endDate,
        roomsByDate: dates.map((date) => ({ date, rooms: Number(roomCounts[date] || 0) })),
        pricePerNight: Number(pricePerNight),
        breakfastIncluded,
      });
      navigate("/revenue/group-quotes");
    } catch (submitError) {
      setError(submitError.message || "The quote could not be created.");
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6 pb-10">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm uppercase tracking-wide text-gray-500">Revenue / Group Quotes</p>
            <h1 className="text-3xl font-semibold">Create Quote</h1>
          </div>
          <button type="button" onClick={() => navigate("/revenue/group-quotes")} className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold hover:bg-gray-100">
            <ArrowLeft className="h-4 w-4" /> Back to overview
          </button>
        </div>

        <Card className="border border-gray-200 bg-white shadow-sm">
          <form className="space-y-6" onSubmit={handleSubmit}>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-semibold">Start Date
                <input required type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal" />
              </label>
              <label className="text-sm font-semibold">End Date
                <input required type="date" min={startDate || undefined} value={endDate} onChange={(event) => setEndDate(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal" />
              </label>
            </div>

            {dates.length > 0 && (
              <fieldset className="space-y-3">
                <legend className="text-base font-semibold">Rooms per date</legend>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {dates.map((date) => (
                    <label key={date} className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm font-medium">
                      {new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
                      <input required min="0" step="1" type="number" value={roomCounts[date] ?? ""} onChange={(event) => setRoomCounts((current) => ({ ...current, [date]: event.target.value }))} placeholder="Number of rooms" className="mt-2 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 font-normal" />
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            <div className="grid items-end gap-4 sm:grid-cols-2">
              <label className="text-sm font-semibold">Price / Night (€)
                <input required min="0" step="0.01" type="number" value={pricePerNight} onChange={(event) => setPricePerNight(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal" />
              </label>
              <label className="flex min-h-11 items-center gap-3 rounded-lg border border-gray-200 px-3 py-2 text-sm font-semibold">
                <input type="checkbox" checked={breakfastIncluded} onChange={(event) => setBreakfastIncluded(event.target.checked)} className="h-4 w-4 accent-[#b41f1f]" />
                Breakfast included
              </label>
            </div>
            {error && <p role="alert" className="text-sm font-medium text-red-700">{error}</p>}
            <div className="flex justify-end">
              <button disabled={saving} type="submit" className="rounded-lg bg-[#b41f1f] px-5 py-2 font-semibold text-white shadow hover:bg-[#961919] disabled:bg-gray-400">
                {saving ? "Creating quote..." : "Create Quote"}
              </button>
            </div>
          </form>
        </Card>
      </PageContainer>
    </div>
  );
}
