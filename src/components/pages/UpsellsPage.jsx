import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ListTodo, Settings } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import DataListTable from "../shared/DataListTable";
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

function getClampedPercentage(value, target) {
  if (!target || target <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / target) * 100)));
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
  const [packageCodes, setPackageCodes] = useState([]);
  const [expandedRankings, setExpandedRankings] = useState({});
  const [selectedRankingUser, setSelectedRankingUser] = useState("");
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
        setPackageCodes([]);
        setSelectedRankingUser("");
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
        setPackageCodes(upsellSettings?.packageCodes || []);
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

  const packageCategoryByCode = useMemo(() => {
    return packageCodes.reduce((categories, packageCode) => {
      const code = String(packageCode?.packageCode || packageCode?.id || "").trim().toUpperCase();
      if (code) categories[code] = String(packageCode?.category || "Uncategorized").trim() || "Uncategorized";
      return categories;
    }, {});
  }, [packageCodes]);

  const revenueRankings = useMemo(() => {
    const expectedRevenueByUser = new Map();
    const effectiveRevenueByUser = new Map();
    const expectedRevenueByCategory = new Map();

    auditUpsells.forEach((record) => {
      const userLabel = getOperaUserLabel(record.operaUser);
      const expectedRevenue = getExpectedRevenue(record);
      if (expectedRevenue !== "") {
        expectedRevenueByUser.set(userLabel, (expectedRevenueByUser.get(userLabel) || 0) + expectedRevenue);
      }

      const packages = Array.isArray(record.packages) && record.packages.length
        ? record.packages
        : [{ packageCode: record.packageCode, startDate: record.startDate, endDate: record.endDate, price: record.price }];

      packages.forEach((packageRecord) => {
        const packageRevenue = getExpectedRevenue(packageRecord);
        if (packageRevenue === "") return;

        const code = String(packageRecord?.packageCode || "").trim().toUpperCase();
        const category = packageCategoryByCode[code] || "Uncategorized";
        expectedRevenueByCategory.set(category, (expectedRevenueByCategory.get(category) || 0) + packageRevenue);
      });

      if (String(record.status || "").toLowerCase() === "validated") {
        const effectiveRevenue = toNumericPrice(record.effectiveRevenue) ?? expectedRevenue;
        if (effectiveRevenue !== "") {
          effectiveRevenueByUser.set(userLabel, (effectiveRevenueByUser.get(userLabel) || 0) + effectiveRevenue);
        }
      }
    });

    const toSortedRanking = (revenueMap) =>
      Array.from(revenueMap.entries())
        .map(([label, revenue]) => ({ label, revenue }))
        .sort((a, b) => b.revenue - a.revenue);

    return {
      expected: toSortedRanking(expectedRevenueByUser),
      effective: toSortedRanking(effectiveRevenueByUser),
      categories: toSortedRanking(expectedRevenueByCategory),
    };
  }, [auditUpsells, operaUserMappings, packageCategoryByCode]);


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

    const dateKeys = getUpsellDateKeys(dateRange.startDate, dateRange.endDate);
    const todayKey = new Date().toISOString().slice(0, 10);
    const elapsedDays = dateKeys.filter((dateKey) => dateKey <= todayKey).length;
    const scheduleTarget = dateKeys.length ? totals.minimum * (Math.min(elapsedDays, dateKeys.length) / dateKeys.length) : 0;
    const scheduleMarker = getClampedPercentage(scheduleTarget, totals.stretch);
    const onSchedule = expectedRevenue >= scheduleTarget;

    const progress = getProgressPercentage(expectedRevenue, totals.stretch);
    const minimumMarker = getProgressPercentage(totals.minimum, totals.stretch);
    const reachMarker = getProgressPercentage(totals.reach, totals.stretch);
    const status = getTargetStatus(expectedRevenue, totals.minimum, totals.reach, totals.stretch);

    return { expectedRevenue, expectedOccupancy: totals.expectedOccupancy, ...totals, progress, minimumMarker, reachMarker, scheduleMarker, scheduleTarget, onSchedule, status };
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
          <p className={`mt-1 inline-flex rounded-full px-2 py-1 text-xs font-semibold ${targetSummary.onSchedule ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
            {targetSummary.onSchedule ? "Op schema t.o.v. Minimum" : "Niet op schema t.o.v. Minimum"}
          </p>
        </div>
      </div>
      <div className="mt-5">
        <div className="relative pt-7">
          <div
            className={`absolute top-0 rounded-full bg-blue-50 px-2 py-1 text-[11px] font-semibold text-blue-700 ring-1 ring-blue-200 ${targetSummary.scheduleMarker >= 95 ? "-translate-x-full" : targetSummary.scheduleMarker <= 5 ? "translate-x-0" : "-translate-x-1/2"}`}
            style={{ left: `${targetSummary.scheduleMarker}%` }}
          >
            Vandaag: {formatPrice(targetSummary.scheduleTarget)}
          </div>
          <div className="relative h-5 rounded-full bg-gray-200">
            <div className={`h-full rounded-full transition-all ${targetSummary.onSchedule ? "bg-emerald-500" : "bg-[#b41f1f]"}`} style={{ width: `${targetSummary.progress}%` }} />
          {[{ label: "Minimum", left: targetSummary.minimumMarker }, { label: "Reach", left: targetSummary.reachMarker }, { label: "Stretch", left: 100 }].map((marker) => (
            <div key={marker.label} className="absolute top-0 h-full w-0.5 bg-gray-900/70" style={{ left: `${marker.left}%` }} title={marker.label} />
          ))}
            <div className="absolute -top-1 h-7 w-1 rounded-full bg-blue-600 shadow-sm ring-2 ring-white" style={{ left: `${targetSummary.scheduleMarker}%` }} title={`Minimum on schedule: ${formatPrice(targetSummary.scheduleTarget)}`} />
          </div>
        </div>
        <div className="relative mt-2 h-10 text-xs text-gray-600">
          {[{ label: "Minimum", value: targetSummary.minimum, left: targetSummary.minimumMarker }, { label: "Reach", value: targetSummary.reach, left: targetSummary.reachMarker }, { label: "Stretch", value: targetSummary.stretch, left: 100 }].map((marker) => {
            const alignmentClass = marker.left >= 95 ? "-translate-x-full" : marker.left <= 5 ? "translate-x-0" : "-translate-x-1/2";

            return (
              <span key={marker.label} className={`absolute whitespace-nowrap ${alignmentClass}`} style={{ left: `${marker.left}%` }}>
                {marker.label} {formatPrice(marker.value)}
              </span>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-gray-500">De blauwe lijn toont hoeveel expected revenue vandaag nodig is om op schema te zitten t.o.v. Minimum ({formatPrice(targetSummary.scheduleTarget)}).</p>
        <p className="mt-3 text-xs text-gray-500">Expected occupancy in selection: {targetSummary.expectedOccupancy} rooms.</p>
      </div>
    </div>
  );

  const RankingCard = ({ id, title, description, rows, emptyMessage, onRowSelect, selectedLabel }) => {
    const isExpanded = Boolean(expandedRankings[id]);
    const visibleRows = isExpanded ? rows : rows.slice(0, 5);

    return (
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-100 p-4">
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
          <p className="mt-1 text-sm text-gray-500">{description}</p>
        </div>
        <div className="divide-y divide-gray-100">
          {visibleRows.length ? (
            visibleRows.map((row, index) => {
              const rowIsSelected = selectedLabel === row.label;
              const rowClassName = `flex w-full items-center justify-between gap-4 px-4 py-3 text-left ${onRowSelect ? "cursor-pointer hover:bg-gray-50" : ""} ${rowIsSelected ? "bg-blue-50" : ""}`;
              const content = (
                <>
                  <div className="flex min-w-0 items-center gap-3">
                    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${rowIsSelected ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600"}`}>
                      {index + 1}
                    </span>
                    <span className="truncate text-sm font-medium text-gray-800">{row.label}</span>
                  </div>
                  <span className="shrink-0 text-sm font-semibold text-gray-800">{formatPrice(row.revenue)}</span>
                </>
              );

              return onRowSelect ? (
                <button key={row.label} type="button" onClick={() => onRowSelect(row.label)} className={rowClassName}>
                  {content}
                </button>
              ) : (
                <div key={row.label} className={rowClassName}>
                  {content}
                </div>
              );
            })
          ) : (
            <div className="p-4 text-sm text-gray-500">{emptyMessage}</div>
          )}
        </div>
        {rows.length > 5 && (
          <button
            type="button"
            onClick={() => setExpandedRankings((current) => ({ ...current, [id]: !current[id] }))}
            className="w-full border-t border-gray-100 px-4 py-3 text-sm font-semibold text-gray-600 hover:bg-gray-50"
          >
            {isExpanded ? "Show top 5" : `Show all ${rows.length}`}
          </button>
        )}
      </div>
    );
  };

  const selectedUserAuditUpsells = useMemo(() => {
    if (!selectedRankingUser) return [];
    return auditUpsells.filter((record) => getOperaUserLabel(record.operaUser) === selectedRankingUser);
  }, [auditUpsells, operaUserMappings, selectedRankingUser]);

  const selectedUserColumns = [
    { key: "logDate", label: "Log Date", sortValue: (row) => row.logDate || row.dateKey },
    { key: "packageCode", label: "Package Code" },
    { key: "arrivalDate", label: "Arrival Date" },
    { key: "departureDate", label: "Departure Date" },
    { key: "price", label: "Price", render: (row) => formatPrice(row.price) },
    { key: "nights", label: "Nights", render: getNights, sortValue: getNights },
    { key: "expectedRevenue", label: "Expected Revenue", render: (row) => formatPrice(getExpectedRevenue(row)), sortValue: getExpectedRevenue },
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
          <div className="grid gap-6 lg:grid-cols-3">
            <RankingCard
              id="expected"
              title="Expected revenue ranking"
              description="All audit upsell statuses are included."
              rows={revenueRankings.expected}
              emptyMessage="No expected revenue found for this period."
              selectedLabel={selectedRankingUser}
              onRowSelect={setSelectedRankingUser}
            />
            <RankingCard
              id="effective"
              title="Effective revenue ranking"
              description='Only audit upsells with status "Validated" are included.'
              rows={revenueRankings.effective}
              emptyMessage="No validated revenue found for this period."
              selectedLabel={selectedRankingUser}
              onRowSelect={setSelectedRankingUser}
            />
            <RankingCard
              id="categories"
              title="Package category ranking"
              description="Expected revenue grouped by configured package category."
              rows={revenueRankings.categories}
              emptyMessage="No package category revenue found for this period."
            />
          </div>
        )}

        {!loading && selectedRankingUser && (
          <section className="space-y-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Audit upsells for {selectedRankingUser}</h2>
                <p className="mt-1 text-sm text-gray-500">All audit upsells in the selected period for the clicked ranking user.</p>
              </div>
              <button type="button" onClick={() => setSelectedRankingUser("")} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50">
                Clear selection
              </button>
            </div>
            <DataListTable
              columns={selectedUserColumns}
              rows={selectedUserAuditUpsells}
              onRowClick={(row) => navigate(`/front-office/upselling/${row.dateKey}/${row.documentId}`)}
              emptyMessage="No audit upsells found for this user."
            />
          </section>
        )}
      </PageContainer>
    </div>
  );
}
