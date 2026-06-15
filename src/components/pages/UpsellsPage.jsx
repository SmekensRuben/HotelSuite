import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ListTodo, Settings } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getAuditUpsells } from "../../services/firebaseUpsells";
import { getSettings } from "../../services/firebaseSettings";

function toDateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getDefaultDateRange() {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  return {
    startDate: toDateInputValue(monthStart),
    endDate: toDateInputValue(today),
  };
}

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

export default function UpsellsPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const defaultDateRange = useMemo(() => getDefaultDateRange(), []);
  const [dateRange, setDateRange] = useState(defaultDateRange);
  const [auditUpsells, setAuditUpsells] = useState([]);
  const [showAuditList, setShowAuditList] = useState(false);
  const [operaUserMappings, setOperaUserMappings] = useState({});
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

  const handleDateRangeChange = (field) => (event) => {
    setDateRange((prev) => ({ ...prev, [field]: event.target.value }));
  };

  const getOperaUserLabel = (operaUserValue) => {
    const operaUser = String(operaUserValue || "").trim();
    return operaUserMappings[operaUser] || operaUserMappings[operaUser.toLowerCase()] || operaUser || "Unknown";
  };

  const revenueRankings = useMemo(() => {
    const expectedRevenueByUser = new Map();
    const effectiveRevenueByUser = new Map();

    auditUpsells.forEach((record) => {
      const userLabel = getOperaUserLabel(record.operaUser);
      const expectedRevenue = getExpectedRevenue(record);
      if (expectedRevenue !== "") {
        expectedRevenueByUser.set(userLabel, (expectedRevenueByUser.get(userLabel) || 0) + expectedRevenue);
      }

      if (String(record.status || "").toLowerCase() === "validated") {
        const effectiveRevenue = toNumericPrice(record.effectiveRevenue) ?? expectedRevenue;
        if (effectiveRevenue !== "") {
          effectiveRevenueByUser.set(userLabel, (effectiveRevenueByUser.get(userLabel) || 0) + effectiveRevenue);
        }
      }
    });

    const toSortedRanking = (revenueMap) =>
      Array.from(revenueMap.entries())
        .map(([operaUser, revenue]) => ({ operaUser, revenue }))
        .sort((a, b) => b.revenue - a.revenue);

    return {
      expected: toSortedRanking(expectedRevenueByUser),
      effective: toSortedRanking(effectiveRevenueByUser),
    };
  }, [auditUpsells, operaUserMappings]);

  const RankingCard = ({ title, description, rows, emptyMessage }) => (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-100 p-4">
        <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
        <p className="mt-1 text-sm text-gray-500">{description}</p>
      </div>
      <div className="divide-y divide-gray-100">
        {rows.length ? (
          rows.map((row, index) => (
            <div key={row.operaUser} className="flex items-center justify-between gap-4 p-4">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-50 text-sm font-semibold text-blue-700">
                  {index + 1}
                </span>
                <span className="truncate font-medium text-gray-900">{row.operaUser}</span>
              </div>
              <span className="shrink-0 font-semibold text-gray-900">{formatPrice(row.revenue)}</span>
            </div>
          ))
        ) : (
          <div className="p-4 text-sm text-gray-500">{emptyMessage}</div>
        )}
      </div>
    </div>
  );

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
            <h1 className="text-3xl font-semibold">Upselling</h1>
            <p className="mt-1 text-gray-600">
              Dashboard van verwachte en effectieve upsell omzet binnen de geselecteerde periode.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowAuditList((prev) => !prev)}
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-700 shadow-sm hover:bg-gray-50"
              aria-label="Toon upsell lijst"
              title="Toon upsell lijst"
            >
              <ListTodo className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => navigate("/front-office/upselling/settings")}
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-700 shadow-sm hover:bg-gray-50"
              aria-label="Open upsell settings"
            >
              <Settings className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="grid gap-4 sm:grid-cols-2 lg:max-w-xl">
            <label className="text-sm font-medium text-gray-700">
              Start date
              <input
                type="date"
                value={dateRange.startDate}
                onChange={handleDateRangeChange("startDate")}
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </label>
            <label className="text-sm font-medium text-gray-700">
              End date
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
            Loading upsell dashboard...
          </div>
        ) : (
          <>
            <div className="grid gap-6 lg:grid-cols-2">
              <RankingCard
                title="Expected revenue ranking"
                description="Alle audit upsell statussen tellen mee."
                rows={revenueRankings.expected}
                emptyMessage="Geen expected revenue gevonden voor deze periode."
              />
              <RankingCard
                title="Effective revenue ranking"
                description='Enkel audit upsells met status "Validated" tellen mee.'
                rows={revenueRankings.effective}
                emptyMessage="Geen validated revenue gevonden voor deze periode."
              />
            </div>

            {showAuditList && (
              <DataListTable
                columns={columns}
                rows={auditUpsells}
                onRowClick={(row) => navigate(`/front-office/upselling/${row.dateKey}/${row.documentId}`)}
                emptyMessage="No audit upsells found for the selected date range."
              />
            )}
          </>
        )}
      </PageContainer>
    </div>
  );
}
