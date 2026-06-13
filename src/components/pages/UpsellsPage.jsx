import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Settings } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getAuditUpsells } from "../../services/firebaseUpsells";

function toDateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getDefaultDateRange() {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - 6);

  return {
    startDate: toDateInputValue(startDate),
    endDate: toDateInputValue(endDate),
  };
}

function formatPrice(value) {
  if (value === "" || value === null || value === undefined) return "";
  const numericValue = Number(value);
  if (Number.isNaN(numericValue)) return value;

  return new Intl.NumberFormat("nl-BE", {
    style: "currency",
    currency: "EUR",
  }).format(numericValue);
}

export default function UpsellsPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const defaultDateRange = useMemo(() => getDefaultDateRange(), []);
  const [dateRange, setDateRange] = useState(defaultDateRange);
  const [auditUpsells, setAuditUpsells] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const today = useMemo(
    () =>
      new Date().toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
    []
  );

  useEffect(() => {
    let active = true;

    async function loadAuditUpsells() {
      if (!hotelUid) {
        setAuditUpsells([]);
        setLoading(false);
        return;
      }

      if (!dateRange.startDate || !dateRange.endDate || dateRange.startDate > dateRange.endDate) {
        setAuditUpsells([]);
        setLoading(false);
        setError("Kies een geldige datumrange.");
        return;
      }

      setLoading(true);
      setError("");

      try {
        const records = await getAuditUpsells(hotelUid, dateRange.startDate, dateRange.endDate);
        if (!active) return;
        setAuditUpsells(records);
      } catch (err) {
        console.error("Failed to load audit upsells", err);
        if (!active) return;
        setError("Audit upsells konden niet geladen worden.");
      } finally {
        if (active) setLoading(false);
      }
    }

    loadAuditUpsells();

    return () => {
      active = false;
    };
  }, [dateRange.endDate, dateRange.startDate, hotelUid]);

  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  const handleDateRangeChange = (field) => (event) => {
    setDateRange((prev) => ({ ...prev, [field]: event.target.value }));
  };

  const columns = [
    { key: "logDate", label: "Log Date", sortValue: (row) => row.logDate || row.dateKey },
    { key: "operaUser", label: "Opera User" },
    { key: "packageCode", label: "Package Code" },
    { key: "price", label: "Price", render: (row) => formatPrice(row.price) },
    { key: "roomNumber", label: "Room Number" },
    { key: "confirmationNumber", label: "Confirmation Number" },
  ];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm uppercase tracking-wide text-gray-500">Front Office</p>
            <h1 className="text-3xl font-semibold">Upselling</h1>
            <p className="mt-1 text-gray-600">
              Overzicht van audit upsells binnen de geselecteerde datumrange.
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate("/front-office/upselling/settings")}
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-700 shadow-sm hover:bg-gray-50"
            aria-label="Upsell settings openen"
          >
            <Settings className="h-5 w-5" />
          </button>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="grid gap-4 sm:grid-cols-2 lg:max-w-xl">
            <label className="text-sm font-medium text-gray-700">
              Startdatum
              <input
                type="date"
                value={dateRange.startDate}
                onChange={handleDateRangeChange("startDate")}
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </label>
            <label className="text-sm font-medium text-gray-700">
              Einddatum
              <input
                type="date"
                value={dateRange.endDate}
                onChange={handleDateRangeChange("endDate")}
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </label>
          </div>
        </div>

        {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        {loading ? (
          <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500 shadow-sm">
            Audit upsells worden geladen...
          </div>
        ) : (
          <DataListTable
            columns={columns}
            rows={auditUpsells}
            emptyMessage="Geen audit upsells gevonden voor de geselecteerde datumrange."
          />
        )}
      </PageContainer>
    </div>
  );
}
