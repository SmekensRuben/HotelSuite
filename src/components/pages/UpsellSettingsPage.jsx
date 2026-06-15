import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Trash2 } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import {
  getUpsellDateKeys,
  getUpsellSettings,
  saveUpsellDailyExpectedOccupancy,
  saveUpsellPackageCodes,
  saveUpsellRevenueTargetRules,
} from "../../services/firebaseUpsells";
import { toDateInputValue } from "./UpsellDateRangeFilter";

const emptyRuleForm = {
  id: "",
  startDate: "",
  endDate: "",
  minimumTargetRevenuePerOccupiedRoom: "",
  reachTargetRevenuePerOccupiedRoom: "",
  stretchTargetRevenuePerOccupiedRoom: "",
};

function addDays(date, days) {
  const nextDate = new Date(date);
  nextDate.setDate(nextDate.getDate() + days);
  return nextDate;
}

function getDefaultOccupancyRange() {
  const today = new Date();
  return { startDate: toDateInputValue(today), endDate: toDateInputValue(addDays(today, 27)) };
}

function formatMonthLabel(dateKey) {
  return new Intl.DateTimeFormat("nl-BE", { month: "long", year: "numeric" }).format(new Date(`${dateKey}T00:00:00`));
}

function toNonNegativeFormNumber(value) {
  const numericValue = Number(value || 0);
  return Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : null;
}

export default function UpsellSettingsPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [packageCodes, setPackageCodes] = useState([]);
  const [dailyExpectedOccupancy, setDailyExpectedOccupancy] = useState({});
  const [revenueTargetRules, setRevenueTargetRules] = useState([]);
  const [newPackageCode, setNewPackageCode] = useState("");
  const [ruleForm, setRuleForm] = useState(emptyRuleForm);
  const [occupancyRange, setOccupancyRange] = useState(getDefaultOccupancyRange);
  const [bulkOccupancy, setBulkOccupancy] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const today = useMemo(
    () => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }),
    []
  );

  useEffect(() => {
    let active = true;

    async function loadSettings() {
      if (!hotelUid) {
        setPackageCodes([]);
        setDailyExpectedOccupancy({});
        setRevenueTargetRules([]);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError("");
      setMessage("");

      try {
        const settings = await getUpsellSettings(hotelUid);
        if (!active) return;
        setPackageCodes(settings.packageCodes || []);
        setDailyExpectedOccupancy(settings.dailyExpectedOccupancy || {});
        setRevenueTargetRules(settings.revenueTargetRules || []);
      } catch (err) {
        console.error("Failed to load upsell settings", err);
        if (!active) return;
        setError("Upsell settings konden niet geladen worden.");
      } finally {
        if (active) setLoading(false);
      }
    }

    loadSettings();
    return () => {
      active = false;
    };
  }, [hotelUid]);

  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  const refreshSettings = async () => {
    const refreshedSettings = await getUpsellSettings(hotelUid);
    setPackageCodes(refreshedSettings.packageCodes || []);
    setDailyExpectedOccupancy(refreshedSettings.dailyExpectedOccupancy || {});
    setRevenueTargetRules(refreshedSettings.revenueTargetRules || []);
  };

  const runSave = async (saveAction, successMessage, failureMessage) => {
    if (!hotelUid) {
      setError("Geen hotel geselecteerd om upsell settings op te slaan.");
      return false;
    }

    setSaving(true);
    setError("");
    setMessage("");

    try {
      await saveAction();
      await refreshSettings();
      setMessage(successMessage);
      return true;
    } catch (err) {
      console.error(failureMessage, err);
      setError(failureMessage);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleAddPackageCode = async (event) => {
    event.preventDefault();
    const normalizedCode = String(newPackageCode || "").trim().toUpperCase();

    if (!normalizedCode) {
      setError("Vul een package code in.");
      return;
    }

    if (packageCodes.includes(normalizedCode)) {
      setError("Deze package code staat al in de lijst.");
      return;
    }

    const saved = await runSave(
      () => saveUpsellPackageCodes(hotelUid, [...packageCodes, normalizedCode]),
      "Package codes opgeslagen in Firebase.",
      "Package codes konden niet opgeslagen worden."
    );
    if (saved) setNewPackageCode("");
  };

  const saveOccupancy = (nextOccupancy, successMessage = "Expected occupancy opgeslagen in Firebase.") =>
    runSave(
      () => saveUpsellDailyExpectedOccupancy(hotelUid, nextOccupancy),
      successMessage,
      "Expected occupancy kon niet opgeslagen worden."
    );

  const handleBulkOccupancySave = async (event) => {
    event.preventDefault();
    const occupancyValue = toNonNegativeFormNumber(bulkOccupancy);
    const dateKeys = getUpsellDateKeys(occupancyRange.startDate, occupancyRange.endDate);

    if (!dateKeys.length || occupancyValue === null) {
      setError("Kies een geldige periode en positieve occupancy waarde.");
      return;
    }

    const nextOccupancy = { ...dailyExpectedOccupancy };
    dateKeys.forEach((dateKey) => {
      nextOccupancy[dateKey] = occupancyValue;
    });

    const saved = await saveOccupancy(nextOccupancy, `Expected occupancy opgeslagen voor ${dateKeys.length} dagen.`);
    if (saved) setBulkOccupancy("");
  };

  const handleOccupancyCellSave = (dateKey, value) => {
    const occupancyValue = toNonNegativeFormNumber(value);
    if (occupancyValue === null) {
      setError("Vul een positieve occupancy waarde in.");
      return;
    }
    saveOccupancy({ ...dailyExpectedOccupancy, [dateKey]: occupancyValue });
  };

  const handleSaveRule = async (event) => {
    event.preventDefault();
    const values = {
      minimumTargetRevenuePerOccupiedRoom: toNonNegativeFormNumber(ruleForm.minimumTargetRevenuePerOccupiedRoom),
      reachTargetRevenuePerOccupiedRoom: toNonNegativeFormNumber(ruleForm.reachTargetRevenuePerOccupiedRoom),
      stretchTargetRevenuePerOccupiedRoom: toNonNegativeFormNumber(ruleForm.stretchTargetRevenuePerOccupiedRoom),
    };

    if (!ruleForm.startDate || !ruleForm.endDate || ruleForm.startDate > ruleForm.endDate || Object.values(values).some((value) => value === null)) {
      setError("Kies een geldige periode en positieve target waardes.");
      return;
    }

    const nextRule = {
      id: ruleForm.id || `${ruleForm.startDate}-${ruleForm.endDate}-${Date.now()}`,
      startDate: ruleForm.startDate,
      endDate: ruleForm.endDate,
      ...values,
    };
    const nextRules = ruleForm.id
      ? revenueTargetRules.map((rule) => (rule.id === ruleForm.id ? nextRule : rule))
      : [...revenueTargetRules, nextRule];

    const saved = await runSave(
      () => saveUpsellRevenueTargetRules(hotelUid, nextRules),
      "Target rule opgeslagen in Firebase.",
      "Target rules konden niet opgeslagen worden."
    );
    if (saved) setRuleForm(emptyRuleForm);
  };

  const occupancyDateKeys = getUpsellDateKeys(occupancyRange.startDate, occupancyRange.endDate);
  const occupancyMonths = occupancyDateKeys.reduce((months, dateKey) => {
    const monthKey = dateKey.slice(0, 7);
    months[monthKey] = [...(months[monthKey] || []), dateKey];
    return months;
  }, {});

  const packageRows = useMemo(() => packageCodes.map((packageCode) => ({ id: packageCode, packageCode })), [packageCodes]);

  const packageColumns = [
    { key: "packageCode", label: "Package Code" },
    {
      key: "actions",
      label: "Acties",
      sortable: false,
      render: (row) => (
        <button
          type="button"
          onClick={() => runSave(() => saveUpsellPackageCodes(hotelUid, packageCodes.filter((code) => code !== row.packageCode)), "Package codes opgeslagen in Firebase.", "Package codes konden niet opgeslagen worden.")}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Trash2 className="h-4 w-4" /> Verwijderen
        </button>
      ),
    },
  ];

  const ruleColumns = [
    { key: "startDate", label: "Start" },
    { key: "endDate", label: "Einde" },
    { key: "minimumTargetRevenuePerOccupiedRoom", label: "Minimum €/Occ. Room" },
    { key: "reachTargetRevenuePerOccupiedRoom", label: "Reach €/Occ. Room" },
    { key: "stretchTargetRevenuePerOccupiedRoom", label: "Stretch €/Occ. Room" },
    {
      key: "actions",
      label: "Acties",
      sortable: false,
      render: (row) => (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setRuleForm(row)} disabled={saving} className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
            Bewerken
          </button>
          <button
            type="button"
            onClick={() => runSave(() => saveUpsellRevenueTargetRules(hotelUid, revenueTargetRules.filter((rule) => rule.id !== row.id)), "Target rule verwijderd.", "Target rules konden niet opgeslagen worden.")}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" /> Verwijderen
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm uppercase tracking-wide text-gray-500">Front Office</p>
            <h1 className="text-3xl font-semibold">Upsell Settings</h1>
            <p className="mt-1 text-gray-600">Beheer expected occupancy per dag en revenue target rules per periode.</p>
          </div>
          <button type="button" onClick={() => navigate("/front-office/upselling")} className="inline-flex h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50">
            Terug naar Upselling
          </button>
        </div>

        {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        {message && <div className="rounded-lg bg-green-50 p-3 text-sm text-green-700">{message}</div>}

        {loading ? (
          <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500 shadow-sm">Upsell settings worden geladen...</div>
        ) : (
          <>
            <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <h2 className="text-lg font-semibold text-gray-900">Expected Occupancy</h2>
              <p className="mt-1 text-sm text-gray-500">Gebruik de kalender om een compacte periode te beheren of pas dezelfde occupancy toe op meerdere dagen tegelijk.</p>
              <form onSubmit={handleBulkOccupancySave} className="mt-4 grid gap-3 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end">
                <label className="text-sm font-semibold text-gray-700">Start<input type="date" value={occupancyRange.startDate} onChange={(event) => setOccupancyRange((range) => ({ ...range, startDate: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
                <label className="text-sm font-semibold text-gray-700">Einde<input type="date" value={occupancyRange.endDate} onChange={(event) => setOccupancyRange((range) => ({ ...range, endDate: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
                <label className="text-sm font-semibold text-gray-700">Bulk occupancy<input type="number" min="0" step="1" value={bulkOccupancy} onChange={(event) => setBulkOccupancy(event.target.value)} placeholder="Kamers" className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
                <button type="submit" disabled={saving} className="rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white shadow hover:bg-[#961919] disabled:opacity-50">Toepassen</button>
              </form>
              <div className="mt-4 space-y-4">
                {Object.entries(occupancyMonths).map(([monthKey, dateKeys]) => (
                  <div key={monthKey}>
                    <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">{formatMonthLabel(`${monthKey}-01`)}</h3>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                      {dateKeys.map((dateKey) => (
                        <label key={dateKey} className="rounded-lg border border-gray-200 bg-gray-50 p-2 text-xs font-medium text-gray-600">
                          <span>{dateKey.slice(8, 10)}</span>
                          <input type="number" min="0" step="1" defaultValue={dailyExpectedOccupancy[dateKey] ?? ""} onBlur={(event) => handleOccupancyCellSave(dateKey, event.target.value)} className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 text-sm text-gray-900" />
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <h2 className="text-lg font-semibold text-gray-900">Revenue Target Rules</h2>
              <p className="mt-1 text-sm text-gray-500">Targets gelden voor een volledige date range en worden gecombineerd met de daily expected occupancy.</p>
              <form onSubmit={handleSaveRule} className="mt-4 grid gap-3 md:grid-cols-3 xl:grid-cols-6 xl:items-end">
                <label className="text-sm font-semibold text-gray-700">Start<input type="date" value={ruleForm.startDate} onChange={(event) => setRuleForm((form) => ({ ...form, startDate: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
                <label className="text-sm font-semibold text-gray-700">Einde<input type="date" value={ruleForm.endDate} onChange={(event) => setRuleForm((form) => ({ ...form, endDate: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
                <label className="text-sm font-semibold text-gray-700">Minimum<input type="number" min="0" step="0.01" value={ruleForm.minimumTargetRevenuePerOccupiedRoom} onChange={(event) => setRuleForm((form) => ({ ...form, minimumTargetRevenuePerOccupiedRoom: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
                <label className="text-sm font-semibold text-gray-700">Reach<input type="number" min="0" step="0.01" value={ruleForm.reachTargetRevenuePerOccupiedRoom} onChange={(event) => setRuleForm((form) => ({ ...form, reachTargetRevenuePerOccupiedRoom: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
                <label className="text-sm font-semibold text-gray-700">Stretch<input type="number" min="0" step="0.01" value={ruleForm.stretchTargetRevenuePerOccupiedRoom} onChange={(event) => setRuleForm((form) => ({ ...form, stretchTargetRevenuePerOccupiedRoom: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
                <button type="submit" disabled={saving} className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white shadow hover:bg-[#961919] disabled:opacity-50"><Plus className="h-4 w-4" /> Rule opslaan</button>
              </form>
              <div className="mt-4"><DataListTable columns={ruleColumns} rows={revenueTargetRules} emptyMessage="Nog geen revenue target rules toegevoegd." /></div>
            </section>

            <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <form onSubmit={handleAddPackageCode}>
                <label htmlFor="package-code" className="block text-sm font-semibold text-gray-700">Package Code toevoegen</label>
                <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                  <input id="package-code" type="text" value={newPackageCode} onChange={(event) => setNewPackageCode(event.target.value)} placeholder="Bijv. PKG_BREAKFAST" className="min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm uppercase" disabled={saving} />
                  <button type="submit" disabled={saving} className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white shadow hover:bg-[#961919] disabled:opacity-50"><Plus className="h-4 w-4" /> Toevoegen</button>
                </div>
              </form>
              <div className="mt-4"><DataListTable columns={packageColumns} rows={packageRows} emptyMessage="Nog geen package codes toegevoegd." /></div>
            </section>
          </>
        )}
      </PageContainer>
    </div>
  );
}
