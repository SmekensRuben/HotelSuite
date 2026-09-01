import React, { useEffect, useMemo, useState } from "react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getMadeReservationDates, getMadeReservations } from "../../services/firebaseArrivals";
import { getSettings } from "../../services/firebaseSettings";
import { calculateNights } from "../../utils/arrivalDates";
import { filterMadeReservations } from "../../utils/arrivalFilters";

function normalizeOperaUserMappings(rawMappings) {
  if (!rawMappings || typeof rawMappings !== "object") return {};

  return Object.entries(rawMappings).reduce((mappings, [operaUser, employeeName]) => {
    const cleanedOperaUser = String(operaUser || "").trim();
    const cleanedEmployeeName = String(employeeName || "").trim();
    if (cleanedOperaUser && cleanedEmployeeName) {
      mappings[cleanedOperaUser] = cleanedEmployeeName;
      mappings[cleanedOperaUser.toLowerCase()] = cleanedEmployeeName;
    }
    return mappings;
  }, {});
}

export default function MadeReservationsPage() {
  const { hotelUid } = useHotelContext();
  const [selectedDate, setSelectedDate] = useState("");
  const [reservations, setReservations] = useState([]);
  const [operaUserMappings, setOperaUserMappings] = useState({});
  const [rateCodeSearch, setRateCodeSearch] = useState("");
  const [includePms, setIncludePms] = useState(false);
  const [loadingDates, setLoadingDates] = useState(true);
  const [loadingReservations, setLoadingReservations] = useState(false);
  const [error, setError] = useState("");
  const today = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);
  const filteredReservations = useMemo(
    () => filterMadeReservations(reservations, rateCodeSearch, includePms),
    [reservations, rateCodeSearch, includePms]
  );
  const columns = useMemo(() => [
    { key: "fullName", label: "Guest Name" },
    { key: "arrivalDate", label: "Arrival" },
    { key: "nights", label: "Nights", sortValue: (record) => calculateNights(record.arrivalDate, record.departureDate), render: (record) => calculateNights(record.arrivalDate, record.departureDate) },
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
    {
      key: "insertUser",
      label: "Created By",
      render: (record) => {
        const operaUser = String(record.insertUser || "").trim();
        return operaUserMappings[operaUser] || operaUserMappings[operaUser.toLowerCase()] || operaUser || "Unknown";
      },
    },
  ], [operaUserMappings]);

  useEffect(() => {
    let active = true;
    setLoadingDates(true);
    setError("");
    setSelectedDate("");
    setReservations([]);
    setOperaUserMappings({});

    if (!hotelUid) {
      setLoadingDates(false);
      return () => { active = false; };
    }

    Promise.all([getMadeReservationDates(hotelUid), getSettings(hotelUid)])
      .then(([dates, settings]) => {
        if (!active) return;
        setSelectedDate(dates[0] || "");
        setOperaUserMappings(normalizeOperaUserMappings(settings?.operaUserMappings));
      })
      .catch(() => active && setError("The reservation dates and OPERA user mappings could not be loaded."))
      .finally(() => active && setLoadingDates(false));

    return () => { active = false; };
  }, [hotelUid]);

  useEffect(() => {
    let active = true;
    if (!hotelUid || !selectedDate) return () => { active = false; };
    setLoadingReservations(true);
    setError("");
    setReservations([]);
    getMadeReservations(hotelUid, selectedDate)
      .then((records) => active && setReservations(records))
      .catch(() => {
        if (active) {
          setReservations([]);
          setError("The made reservations could not be loaded.");
        }
      })
      .finally(() => active && setLoadingReservations(false));
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
          <h1 className="text-3xl font-semibold">Made Reservations</h1>
          <p className="mt-1 text-gray-600">Reservations made on the selected date.</p>
        </div>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="w-full sm:w-64">
            <label htmlFor="reservation-made-date" className="mb-1 block text-sm font-medium text-gray-700">Reservation made date</label>
            <input
              id="reservation-made-date"
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

          <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm font-medium text-gray-700">
            <input
              type="checkbox"
              checked={includePms}
              onChange={(event) => setIncludePms(event.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-blue-600"
            />
            <span>Include PM&apos;s</span>
          </label>
        </div>

        {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        {(loadingDates || loadingReservations) ? <p className="text-sm text-gray-600">Loading made reservations...</p> : <DataListTable columns={columns} rows={filteredReservations} emptyMessage={selectedDate ? "No made reservations match the selected filters." : "Select a reservation made date."} />}
      </PageContainer>
    </div>
  );
}
