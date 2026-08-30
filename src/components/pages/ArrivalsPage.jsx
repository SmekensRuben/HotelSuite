import React, { useEffect, useMemo, useState } from "react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getArrivalDates, getArrivals } from "../../services/firebaseArrivals";
import { calculateNights } from "../../utils/arrivalDates";

function getMembershipLevel(record) {
  if (Array.isArray(record.memberships)) return record.memberships[0]?.membershipLevel || "";
  if (record.memberships && typeof record.memberships === "object") {
    return Object.values(record.memberships)[0]?.membershipLevel || "";
  }
  return "";
}

const columns = [
  { key: "fullName", label: "Guest Name" },
  { key: "arrivalDate", label: "Arrival" },
  { key: "nights", label: "Nights", sortValue: (record) => calculateNights(record.arrivalDate, record.departureDate), render: (record) => calculateNights(record.arrivalDate, record.departureDate) },
  { key: "roomNumber", label: "Room" },
  { key: "roomCategoryLabel", label: "Room Type" },
  { key: "rateCode", label: "Rate Code" },
  { key: "membership", label: "Membership", sortValue: getMembershipLevel, render: getMembershipLevel },
];

export default function ArrivalsPage() {
  const { hotelUid } = useHotelContext();
  const [selectedDate, setSelectedDate] = useState("");
  const [arrivals, setArrivals] = useState([]);
  const [loadingDates, setLoadingDates] = useState(true);
  const [loadingArrivals, setLoadingArrivals] = useState(false);
  const [error, setError] = useState("");
  const today = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);

  useEffect(() => {
    let active = true;
    setLoadingDates(true);
    setError("");
    setSelectedDate("");
    setArrivals([]);

    if (!hotelUid) {
      setLoadingDates(false);
      return () => { active = false; };
    }

    getArrivalDates(hotelUid)
      .then((dates) => {
        if (!active) return;
        setSelectedDate(dates[0] || "");
      })
      .catch(() => active && setError("The available arrival dates could not be loaded."))
      .finally(() => active && setLoadingDates(false));

    return () => { active = false; };
  }, [hotelUid]);

  useEffect(() => {
    let active = true;
    if (!hotelUid || !selectedDate) return () => { active = false; };
    setLoadingArrivals(true);
    setError("");
    setArrivals([]);
    getArrivals(hotelUid, selectedDate)
      .then((records) => active && setArrivals(records))
      .catch(() => {
        if (active) {
          setArrivals([]);
          setError("The arrivals could not be loaded.");
        }
      })
      .finally(() => active && setLoadingArrivals(false));
    return () => { active = false; };
  }, [hotelUid, selectedDate]);

  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div>
          <p className="text-sm uppercase tracking-wide text-gray-500">Front Office</p>
          <h1 className="text-3xl font-semibold">Arrivals</h1>
          <p className="mt-1 text-gray-600">Reservations scheduled to arrive at the hotel.</p>
        </div>

        <div className="w-full sm:w-64">
          <label htmlFor="arrival-date" className="mb-1 block text-sm font-medium text-gray-700">Arrival date</label>
          <input
            id="arrival-date"
            type="date"
            value={selectedDate}
            onChange={(event) => setSelectedDate(event.target.value)}
            disabled={loadingDates || !hotelUid}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:bg-gray-100"
          />
        </div>

        {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        {(loadingDates || loadingArrivals) ? <p className="text-sm text-gray-600">Loading arrivals...</p> : <DataListTable columns={columns} rows={arrivals} emptyMessage={selectedDate ? "No arrivals found for this date." : "Select an arrival date."} />}
      </PageContainer>
    </div>
  );
}
