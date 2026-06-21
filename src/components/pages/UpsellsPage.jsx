import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ListTodo, Settings } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getAuditUpsells, getUpsellDateKeys, getUpsellSettings } from "../../services/firebaseUpsells";
import { getSettings } from "../../services/firebaseSettings";
import { usePermission } from "../../hooks/usePermission";
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


function getProgressPercentage(value, target) {
  if (!target || target <= 0) return 0;
  return Math.min(100, Math.round((value / target) * 100));
}

function getTargetRuleForDate(dateKey, rules) {
  return rules.find((rule) => rule.startDate <= dateKey && dateKey <= rule.endDate) || null;
}

function getTargetStatus(expectedRevenue, minimumTarget, reachTarget, stretchTarget) {
  if (stretchTarget > 0 && expectedRevenue >= stretchTarget) return "aboveStretch";
  if (reachTarget > 0 && expectedRevenue >= reachTarget) return "betweenReachAndStretch";
  if (minimumTarget > 0 && expectedRevenue >= minimumTarget) return "betweenMinimumAndReach";
  return "belowMinimum";
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
  const canManageAuditUpsells = usePermission("auditUpsells", "settings");
  const defaultDateRange = useMemo(() => getDateRangeForPreset("thisMonth"), []);
  const [dateRange, setDateRange] = useState(defaultDateRange);
  const [dateRangePreset, setDateRangePreset] = useState("thisMonth");
  const [auditUpsells, setAuditUpsells] = useState([]);
  const [operaUserMappings, setOperaUserMappings] = useState({});
  const [dailyExpectedOccupancy, setDailyExpectedOccupancy] = useState({});
  const [revenueTargetRules, setRevenueTargetRules] = useState([]);
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
        setDailyExpectedOccupancy({});
        setRevenueTargetRules([]);
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
          getAuditUpsells(hotelUid, dateRange.startDate, dateRange.endDate, { dateFilter: "departureDate" }),
          getSettings(hotelUid),
          getUpsellSettings(hotelUid),
        ]);
        if (!active) return;
        setAuditUpsells(records);
        setOperaUserMappings(normalizeOperaUserMappings(settings?.operaUserMappings));
        setDailyExpectedOccupancy(upsellSettings?.dailyExpectedOccupancy || {});
        setRevenueTargetRules(upsellSettings?.revenueTargetRules || []);
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
        const rule = getTargetRuleForDate(dateKey, revenueTargetRules);
        const expectedOccupancy = Number(dailyExpectedOccupancy[dateKey] || 0);
        accumulator.expectedOccupancy += expectedOccupancy;

        if (rule) {
          accumulator.minimum += expectedOccupancy * Number(rule.minimumTargetRevenuePerOccupiedRoom || 0);
          accumulator.reach += expectedOccupancy * Number(rule.reachTargetRevenuePerOccupiedRoom || 0);
          accumulator.stretch += expectedOccupancy * Number(rule.stretchTargetRevenuePerOccupiedRoom || 0);
        }

        return accumulator;
      },
      { expectedOccupancy: 0, minimum: 0, reach: 0, stretch: 0 }
    );

    const progress = getProgressPercentage(expectedRevenue, totals.stretch);
    const minimumMarker = getProgressPercentage(totals.minimum, totals.stretch);
    const reachMarker = getProgressPercentage(totals.reach, totals.stretch);
    const status = getTargetStatus(expectedRevenue, totals.minimum, totals.reach, totals.stretch);

    return { expectedRevenue, expectedOccupancy: totals.expectedOccupancy, ...totals, progress, minimumMarker, reachMarker, status };
  }, [auditUpsells, dailyExpectedOccupancy, dateRange.endDate, dateRange.startDate, revenueTargetRules]);

  const statusLabels = {
    belowMinimum: "Below Minimum",
    betweenMinimumAndReach: "Between Minimum and Reach",
    betweenReachAndStretch: "Between Reach and Stretch",
    aboveStretch: "Above Stretch",
  };

  const TargetSummaryCard = () => (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Target revenue progress</h2>
          <p className="mt-1 text-sm text-gray-500">One progress bar toward Stretch, with Minimum and Reach thresholds.</p>
        </div>
        <div className="text-left sm:text-right">
          <p className="text-sm text-gray-500">Expected revenue</p>
          <p className="text-2xl font-semibold text-gray-900">{formatPrice(targetSummary.expectedRevenue)}</p>
          <p className="text-xs font-medium text-gray-600">{statusLabels[targetSummary.status]} · {targetSummary.progress}% of Stretch</p>
        </div>
      </div>
      <div className="mt-5">
        <div className="relative h-5 overflow-hidden rounded-full bg-gray-200">
          <div className="h-full rounded-full bg-[#b41f1f] transition-all" style={{ width: `${targetSummary.progress}%` }} />
          {[{ label: "Minimum", left: targetSummary.minimumMarker }, { label: "Reach", left: targetSummary.reachMarker }, { label: "Stretch", left: 100 }].map((marker) => (
            <div key={marker.label} className="absolute top-0 h-full w-0.5 bg-gray-900/70" style={{ left: `${marker.left}%` }} title={marker.label} />
          ))}
        </div>
        <div className="mt-2 flex justify-between gap-3 text-xs text-gray-600">
          <span>Minimum {formatPrice(targetSummary.minimum)}</span>
          <span>Reach {formatPrice(targetSummary.reach)}</span>
          <span>Stretch {formatPrice(targetSummary.stretch)}</span>
        </div>
        <p className="mt-3 text-xs text-gray-500">Expected occupancy in selection: {targetSummary.expectedOccupancy} rooms.</p>
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
              Dashboard for expected and effective upsell revenue in the selected period.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <UpsellDateRangeFilter
              dateRange={dateRange}
              preset={dateRangePreset}
              onPresetChange={setDateRangePreset}
              onDateRangeChange={setDateRange}
              compact
            />
            {canManageAuditUpsells && (
              <button
                type="button"
                onClick={() => navigate("/front-office/upselling/audit")}
                className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-700 shadow-sm hover:bg-gray-50"
                aria-label="Open Upsell Audit"
                title="Open Upsell Audit"
              >
                <ListTodo className="h-5 w-5" />
              </button>
            )}
            {canManageAuditUpsells && (
              <button
                type="button"
                onClick={() => navigate("/front-office/upselling/settings")}
                className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-700 shadow-sm hover:bg-gray-50"
                aria-label="Open upsell settings"
              >
                <Settings className="h-5 w-5" />
              </button>
            )}
          </div>
        </div>

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
              description="All audit upsell statuses are included."
              rows={revenueRankings.expected}
              emptyMessage="No expected revenue found for this period."
            />
            <RankingCard
              title="Effective revenue ranking"
              description='Only audit upsells with status "Validated" are included.'
              rows={revenueRankings.effective}
              emptyMessage="No validated revenue found for this period."
            />
          </div>
        )}
      </PageContainer>
    </div>
  );
}
