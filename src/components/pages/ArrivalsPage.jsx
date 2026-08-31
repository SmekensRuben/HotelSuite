import React, { useEffect, useMemo, useState } from "react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getArrivalDates, getArrivals, getLatestRateCodeDescriptions } from "../../services/firebaseArrivals";
import { calculateNights } from "../../utils/arrivalDates";
import { filterArrivals, getMembershipLevels } from "../../utils/arrivalFilters";

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
  {
    key: "description",
    label: "Description",
    render: (record) => (
      <div className="max-w-64 truncate" title={record.description || ""}>
        {record.description}
      </div>
    ),
  },
  { key: "membership", label: "Membership", sortValue: getMembershipLevel, render: getMembershipLevel },
];

export default function ArrivalsPage() {
  const { hotelUid } = useHotelContext();
  const [selectedDate, setSelectedDate] = useState("");
  const [arrivals, setArrivals] = useState([]);
  const [rateCodeSearch, setRateCodeSearch] = useState("");
  const [selectedMemberships, setSelectedMemberships] = useState([]);
  const [loadingDates, setLoadingDates] = useState(true);
  const [loadingArrivals, setLoadingArrivals] = useState(false);
  const [error, setError] = useState("");
  const today = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);
  const availableMemberships = useMemo(() => (
    [...new Set(arrivals.flatMap(getMembershipLevels))]
      .sort((first, second) => first.localeCompare(second))
  ), [arrivals]);
  const filteredArrivals = useMemo(
    () => filterArrivals(arrivals, rateCodeSearch, selectedMemberships),
    [arrivals, rateCodeSearch, selectedMemberships]
  );

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
    Promise.all([
      getArrivals(hotelUid, selectedDate),
      getLatestRateCodeDescriptions(hotelUid),
    ])
      .then(([records, descriptions]) => active && setArrivals(records.map((record) => ({
        ...record,
        description: descriptions[String(record.rateCode || "").trim()] || "",
      }))))
      .catch(() => {
        if (active) {
          setArrivals([]);
          setError("The arrivals could not be loaded.");
        }
      })
      .finally(() => active && setLoadingArrivals(false));
    return () => { active = false; };
  }, [hotelUid, selectedDate]);

  useEffect(() => {
    setSelectedMemberships((current) => current.filter((membership) => availableMemberships.includes(membership)));
  }, [availableMemberships]);

  const toggleMembership = (membership) => {
    setSelectedMemberships((current) => (
      current.includes(membership)
        ? current.filter((item) => item !== membership)
        : [...current, membership]
    ));
  };

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

        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
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

          <div className="w-full sm:w-64">
            <label htmlFor="rate-code-filter" className="mb-1 block text-sm font-medium text-gray-700">Rate Code</label>
            <input
              id="rate-code-filter"
              type="search"
              value={rateCodeSearch}
              onChange={(event) => setRateCodeSearch(event.target.value)}
              placeholder="Search Rate Code"
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
            />
          </div>

          <div className="w-full sm:w-64">
            <span className="mb-1 block text-sm font-medium text-gray-700">Membership</span>
            <details className="relative">
              <summary className="flex cursor-pointer list-none items-center justify-between rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm marker:content-none">
                <span className="truncate">
                  {selectedMemberships.length === 0 ? "All memberships" : `${selectedMemberships.length} selected`}
                </span>
                <span aria-hidden="true" className="ml-2 text-xs text-gray-500">▼</span>
              </summary>
              <div className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white p-2 shadow-lg">
                {availableMemberships.length === 0 ? (
                  <p className="px-2 py-1 text-sm text-gray-500">No memberships available</p>
                ) : availableMemberships.map((membership) => (
                  <label key={membership} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-gray-50">
                    <input
                      type="checkbox"
                      checked={selectedMemberships.includes(membership)}
                      onChange={() => toggleMembership(membership)}
                      className="h-4 w-4 rounded border-gray-300 text-blue-600"
                    />
                    <span className="truncate" title={membership}>{membership}</span>
                  </label>
                ))}
              </div>
            </details>
          </div>
        </div>

        {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        {(loadingDates || loadingArrivals) ? <p className="text-sm text-gray-600">Loading arrivals...</p> : <DataListTable columns={columns} rows={filteredArrivals} emptyMessage={selectedDate ? "No arrivals match the selected filters." : "Select an arrival date."} />}
      </PageContainer>
    </div>
  );
}
