import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getAuditUpsells } from "../../services/firebaseUpsells";
import { getSettings } from "../../services/firebaseSettings";
import UpsellDateRangeFilter, { getDateRangeForPreset } from "./UpsellDateRangeFilter";

function toNumericPrice(value) {
  if (value === "" || value === null || value === undefined) return null;
  if (typeof value === "number") return value;

  const normalizedValue = String(value)
    .trim()
    .replace(/[^\d,.-]/g, "")
    .replace(",", ".");
  const numericValue = Number(normalizedValue);
  return Number.isNaN(numericValue) ? null : numericValue;
}

function formatPrice(value) {
  const numericValue = toNumericPrice(value);
  if (numericValue === null) return value ?? "";

  return new Intl.NumberFormat("nl-BE", {
    style: "currency",
    currency: "EUR",
  }).format(numericValue);
}

function parseDateKey(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ""))) return null;

  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

function getNights(row) {
  const startDate = parseDateKey(row.startDate);
  const endDate = parseDateKey(row.endDate);
  if (!startDate || !endDate || startDate > endDate) return "";

  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.round((endDate - startDate) / millisecondsPerDay) + 1;
}

function getExpectedRevenue(row) {
  if (Array.isArray(row.packages) && row.packages.length) {
    const total = row.packages.reduce((sum, packageRecord) => {
      const startDate = parseDateKey(packageRecord?.startDate);
      const endDate = parseDateKey(packageRecord?.endDate);
      const price = toNumericPrice(packageRecord?.price);
      if (!startDate || !endDate || startDate > endDate || price === null) return sum;

      const millisecondsPerDay = 24 * 60 * 60 * 1000;
      const nights = Math.round((endDate - startDate) / millisecondsPerDay) + 1;
      return sum + price * nights;
    }, 0);

    return total;
  }

  const nights = getNights(row);
  const price = toNumericPrice(row.price);
  if (nights === "" || price === null) return "";

  return price * nights;
}

function normalizeOperaUserMappings(rawMappings) {
  if (!rawMappings || typeof rawMappings !== "object") return {};

  return Object.entries(rawMappings).reduce((accumulator, [operaUser, employeeName]) => {
    const cleanedOperaUser = String(operaUser || "").trim();
    const cleanedEmployeeName = String(employeeName || "").trim();

    if (cleanedOperaUser && cleanedEmployeeName) {
      accumulator[cleanedOperaUser] = cleanedEmployeeName;
      accumulator[cleanedOperaUser.toLowerCase()] = cleanedEmployeeName;
    }

    return accumulator;
  }, {});
}

export default function UpsellAuditPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const defaultDateRange = useMemo(() => getDateRangeForPreset("thisMonth"), []);
  const [dateRange, setDateRange] = useState(defaultDateRange);
  const [dateRangePreset, setDateRangePreset] = useState("thisMonth");
  const [auditUpsells, setAuditUpsells] = useState([]);
  const [operaUserMappings, setOperaUserMappings] = useState({});
  const [selectedStatuses, setSelectedStatuses] = useState(["Checked Out"]);
  const [statusDropdownOpen, setStatusDropdownOpen] = useState(false);
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
        setOperaUserMappings({});
        setLoading(false);
        return;
      }

      if (!dateRange.startDate || !dateRange.endDate || dateRange.startDate > dateRange.endDate) {
        setAuditUpsells([]);
        setLoading(false);
        setError("Choose a valid date range.");
        return;
      }

      setLoading(true);
      setError("");

      try {
        const [records, settings] = await Promise.all([
          getAuditUpsells(hotelUid, dateRange.startDate, dateRange.endDate),
          getSettings(hotelUid),
        ]);
        if (!active) return;
        setAuditUpsells(records);
        setOperaUserMappings(normalizeOperaUserMappings(settings?.operaUserMappings));
      } catch (err) {
        console.error("Failed to load audit upsells", err);
        if (!active) return;
        setError("Audit upsells could not be loaded.");
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


  const statusOptions = useMemo(() => {
    const statuses = new Set(["Checked Out"]);
    auditUpsells.forEach((record) => {
      if (record.status) statuses.add(record.status);
    });
    return Array.from(statuses).sort((a, b) => a.localeCompare(b));
  }, [auditUpsells]);

  const filteredAuditUpsells = useMemo(() => {
    if (!selectedStatuses.length) return [];
    return auditUpsells.filter((record) => selectedStatuses.includes(record.status));
  }, [auditUpsells, selectedStatuses]);

  const handleStatusToggle = (status) => {
    setSelectedStatuses((currentStatuses) =>
      currentStatuses.includes(status)
        ? currentStatuses.filter((currentStatus) => currentStatus !== status)
        : [...currentStatuses, status]
    );
  };

  const columns = [
    { key: "logDate", label: "Log Date", sortValue: (row) => row.logDate || row.dateKey },
    {
      key: "operaUser",
      label: "Opera User",
      render: (row) => {
        const operaUser = String(row.operaUser || "").trim();
        return operaUserMappings[operaUser] || operaUserMappings[operaUser.toLowerCase()] || operaUser;
      },
    },
    { key: "packageCode", label: "Package Code" },
    { key: "arrivalDate", label: "Arrival Date" },
    { key: "departureDate", label: "Departure Date" },
    { key: "price", label: "Price", render: (row) => formatPrice(row.price) },
    { key: "nights", label: "Nights", render: getNights, sortValue: getNights },
    {
      key: "expectedRevenue",
      label: "Expected Revenue",
      render: (row) => formatPrice(getExpectedRevenue(row)),
      sortValue: getExpectedRevenue,
    },
    { key: "status", label: "Status" },
    { key: "confirmationNumber", label: "Confirmation Number" },
  ];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm uppercase tracking-wide text-gray-500">Front Office</p>
            <h1 className="text-3xl font-semibold">Upsell Audit</h1>
            <p className="mt-1 text-gray-600">Audit upsells within the selected date range.</p>
          </div>
          <button
            type="button"
            onClick={() => navigate("/front-office/upselling")}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
          >
            <ArrowLeft className="h-4 w-4" /> Back to Upselling
          </button>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <UpsellDateRangeFilter
              dateRange={dateRange}
              preset={dateRangePreset}
              onPresetChange={setDateRangePreset}
              onDateRangeChange={setDateRange}
              compact
            />
            <div className="relative">
              <p className="text-sm font-medium text-gray-700">Status</p>
              <button
                type="button"
                onClick={() => setStatusDropdownOpen((open) => !open)}
                className="mt-2 inline-flex min-w-48 items-center justify-between gap-3 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
              >
                <span>{selectedStatuses.length ? `${selectedStatuses.length} selected` : "No statuses selected"}</span>
                <span aria-hidden="true">▾</span>
              </button>
              {statusDropdownOpen && (
                <div className="absolute right-0 z-10 mt-2 w-64 rounded-lg border border-gray-200 bg-white p-2 shadow-lg">
                  {statusOptions.map((status) => (
                    <label key={status} className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
                      <input
                        type="checkbox"
                        checked={selectedStatuses.includes(status)}
                        onChange={() => handleStatusToggle(status)}
                        className="h-4 w-4 rounded border-gray-300 text-[#b41f1f] focus:ring-[#b41f1f]"
                      />
                      {status}
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        {loading ? (
          <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500 shadow-sm">
            Loading audit upsells...
          </div>
        ) : (
          <DataListTable
            columns={columns}
            rows={filteredAuditUpsells}
            onRowClick={(row) => navigate(`/front-office/upselling/${row.dateKey}/${row.documentId}`)}
            emptyMessage="No audit upsells found for the selected date range and status filters."
          />
        )}
      </PageContainer>
    </div>
  );
}
