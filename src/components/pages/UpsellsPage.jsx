import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ListTodo, Settings } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getAuditUpsells, getUpsellDateKeys, getUpsellSettings } from "../../services/firebaseUpsells";
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
  const nights = getNights(row);
  const price = toNumericPrice(row.price);
  if (nights === "" || price === null) return "";

  return price * nights;
}


function getProgressPercentage(value, target) {
  if (!target || target <= 0) return 0;
  return Math.min(100, Math.round((value / target) * 100));
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
  const defaultDateRange = useMemo(() => getDateRangeForPreset("thisMonth"), []);
  const [dateRange, setDateRange] = useState(defaultDateRange);
  const [dateRangePreset, setDateRangePreset] = useState("thisMonth");
  const [auditUpsells, setAuditUpsells] = useState([]);
  const [operaUserMappings, setOperaUserMappings] = useState({});
  const [dailyRevenueTargets, setDailyRevenueTargets] = useState({});
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
        setDailyRevenueTargets({});
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
        const [records, settings, upsellSettings] = await Promise.all([
          getAuditUpsells(hotelUid, dateRange.startDate, dateRange.endDate),
          getSettings(hotelUid),
          getUpsellSettings(hotelUid),
        ]);
        if (!active) return;
        setAuditUpsells(records);
        setOperaUserMappings(normalizeOperaUserMappings(settings?.operaUserMappings));
        setDailyRevenueTargets(upsellSettings?.dailyRevenueTargets || {});
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


  const targetSummary = useMemo(() => {
    const expectedRevenue = auditUpsells.reduce((total, record) => {
      const recordExpectedRevenue = getExpectedRevenue(record);
      return recordExpectedRevenue === "" ? total : total + recordExpectedRevenue;
    }, 0);

    const totals = getUpsellDateKeys(dateRange.startDate, dateRange.endDate).reduce(
      (accumulator, dateKey) => {
        const target = dailyRevenueTargets[dateKey] || {};
        const expectedOccupancy = Number(target.expectedOccupancy || 0);
        accumulator.expectedOccupancy += expectedOccupancy;
        accumulator.minimum += expectedOccupancy * Number(target.minimumRevenuePerOccupiedRoom || 0);
        accumulator.reach += expectedOccupancy * Number(target.reachRevenuePerOccupiedRoom || 0);
        accumulator.stretch += expectedOccupancy * Number(target.stretchRevenuePerOccupiedRoom || 0);
        return accumulator;
      },
      { expectedOccupancy: 0, minimum: 0, reach: 0, stretch: 0 }
    );

    return {
      expectedRevenue,
      expectedOccupancy: totals.expectedOccupancy,
      targets: [
        { key: "minimum", label: "Minimum", value: totals.minimum },
        { key: "reach", label: "Reach", value: totals.reach },
        { key: "stretch", label: "Stretch", value: totals.stretch },
      ],
    };
  }, [auditUpsells, dailyRevenueTargets, dateRange.endDate, dateRange.startDate]);

  const TargetSummaryCard = () => (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Target revenue summary</h2>
          <p className="mt-1 text-sm text-gray-500">Progress op basis van expected revenue tegenover de targets uit Upsell Settings.</p>
        </div>
        <div className="text-left sm:text-right">
          <p className="text-sm text-gray-500">Expected revenue</p>
          <p className="text-2xl font-semibold text-gray-900">{formatPrice(targetSummary.expectedRevenue)}</p>
          <p className="text-xs text-gray-500">Expected occupancy: {targetSummary.expectedOccupancy} kamers</p>
        </div>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {targetSummary.targets.map((target) => {
          const progress = getProgressPercentage(targetSummary.expectedRevenue, target.value);
          return (
            <div key={target.key} className="rounded-lg border border-gray-100 bg-gray-50 p-3">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="font-semibold text-gray-800">{target.label}</span>
                <span className="text-gray-600">{formatPrice(target.value)}</span>
              </div>
              <div className="mt-3 h-3 overflow-hidden rounded-full bg-gray-200">
                <div
                  className="h-full rounded-full bg-[#b41f1f] transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="mt-2 text-xs font-medium text-gray-600">{progress}% van target revenue</p>
            </div>
          );
        })}
      </div>
    </div>
  );

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
              onClick={() => navigate("/front-office/upselling/audit")}
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-700 shadow-sm hover:bg-gray-50"
              aria-label="Open Upsell Audit"
              title="Open Upsell Audit"
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

        <UpsellDateRangeFilter
          dateRange={dateRange}
          preset={dateRangePreset}
          onPresetChange={setDateRangePreset}
          onDateRangeChange={setDateRange}
        />

        {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        {!loading && <TargetSummaryCard />}
        {loading ? (
          <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500 shadow-sm">
            Loading upsell dashboard...
          </div>
        ) : (
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
        )}
      </PageContainer>
    </div>
  );
}
