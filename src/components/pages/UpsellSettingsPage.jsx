import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Trash2, Upload } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import DataListTable from "../shared/DataListTable";
import { auth, ref, signOut, storage, uploadBytes } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import {
  getUpsellDateKeys,
  getUpsellSettings,
  deleteUpsellPackageCode,
  saveUpsellDailyExpectedOccupancy,
  saveUpsellPackageCode,
  saveUpsellRevenueTargetRules,
} from "../../services/firebaseUpsells";
import { getFileImportTypes } from "../../services/firebaseSettings";
import { toDateInputValue } from "./UpsellDateRangeFilter";

const emptyManualImportForm = {
  fileImportTypeId: "",
  targetDate: toDateInputValue(new Date()),
  file: null,
};

const emptyPackageCodeForm = {
  packageCode: "",
  category: "",
  description: "",
};

const emptyRuleForm = {
  id: "",
  startDate: "",
  endDate: "",
  minimumTargetRevenuePerOccupiedRoom: "",
  reachTargetRevenuePerOccupiedRoom: "",
  stretchTargetRevenuePerOccupiedRoom: "",
};

function getDefaultOccupancyRange() {
  const today = new Date();
  const startDate = new Date(today);
  startDate.setDate(1);
  const endDate = new Date(today);
  endDate.setMonth(today.getMonth() + 1, 0);
  return { startDate: toDateInputValue(startDate), endDate: toDateInputValue(endDate) };
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
  const [fileImportTypes, setFileImportTypes] = useState([]);
  const [packageCodeForm, setPackageCodeForm] = useState(emptyPackageCodeForm);
  const [ruleForm, setRuleForm] = useState(emptyRuleForm);
  const [occupancyRange, setOccupancyRange] = useState(getDefaultOccupancyRange);
  const [bulkOccupancy, setBulkOccupancy] = useState("");
  const [manualImportForm, setManualImportForm] = useState(emptyManualImportForm);
  const [occupancyOpen, setOccupancyOpen] = useState(false);
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
        setFileImportTypes([]);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError("");
      setMessage("");

      try {
        const [settings, importTypes] = await Promise.all([
          getUpsellSettings(hotelUid),
          getFileImportTypes(hotelUid),
        ]);
        if (!active) return;
        setPackageCodes(settings.packageCodes || []);
        setDailyExpectedOccupancy(settings.dailyExpectedOccupancy || {});
        setRevenueTargetRules(settings.revenueTargetRules || []);
        setFileImportTypes(importTypes.filter((importType) => importType.enabled !== false));
      } catch (err) {
        console.error("Failed to load upsell settings", err);
        if (!active) return;
        setError("Upsell settings could not be loaded.");
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
      setError("No hotel selected to save upsell settings.");
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
    const normalizedCode = String(packageCodeForm.packageCode || "").trim().toUpperCase();

    if (!normalizedCode) {
      setError("Enter a package code.");
      return;
    }

    if (packageCodes.some((packageCode) => packageCode.packageCode === normalizedCode)) {
      setError("This package code is already in the list.");
      return;
    }

    const saved = await runSave(
      () => saveUpsellPackageCode(hotelUid, { ...packageCodeForm, packageCode: normalizedCode }),
      "Package code saved in Firebase.",
      "Package codes could not be saved."
    );
    if (saved) setPackageCodeForm(emptyPackageCodeForm);
  };

  const saveOccupancy = (nextOccupancy, successMessage = "Expected occupancy saved in Firebase.") =>
    runSave(
      () => saveUpsellDailyExpectedOccupancy(hotelUid, nextOccupancy),
      successMessage,
      "Expected occupancy could not be saved."
    );

  const handleBulkOccupancySave = async (event) => {
    event.preventDefault();
    const occupancyValue = toNonNegativeFormNumber(bulkOccupancy);
    const dateKeys = getUpsellDateKeys(occupancyRange.startDate, occupancyRange.endDate);

    if (!dateKeys.length || occupancyValue === null) {
      setError("Choose a valid period and positive occupancy value.");
      return;
    }

    const nextOccupancy = { ...dailyExpectedOccupancy };
    dateKeys.forEach((dateKey) => {
      nextOccupancy[dateKey] = occupancyValue;
    });

    setDailyExpectedOccupancy(nextOccupancy);
    const saved = await saveOccupancy(nextOccupancy, `Expected occupancy saved for ${dateKeys.length} days.`);
    if (saved) setBulkOccupancy("");
  };

  const handleOccupancyCellSave = (dateKey, value) => {
    const occupancyValue = toNonNegativeFormNumber(value);
    if (occupancyValue === null) {
      setError("Enter a positive occupancy value.");
      return;
    }
    saveOccupancy({ ...dailyExpectedOccupancy, [dateKey]: occupancyValue });
  };

  const handleManualImportUpload = async (event) => {
    event.preventDefault();

    if (!hotelUid) {
      setError("No hotel selected to upload an import file.");
      return;
    }

    const selectedImportType = fileImportTypes.find((importType) => importType.id === manualImportForm.fileImportTypeId);
    if (!selectedImportType?.fileType) {
      setError("Select a file import type.");
      return;
    }

    if (!manualImportForm.targetDate) {
      setError("Choose an import date.");
      return;
    }

    if (!manualImportForm.file) {
      setError("Choose a file to upload.");
      return;
    }

    setSaving(true);
    setError("");
    setMessage("");

    try {
      const safeName = manualImportForm.file.name.replace(/[^a-zA-Z0-9._-]+/g, "_");
      const storagePath = `imports/manual/${hotelUid}/${Date.now()}-${safeName}`;
      const fileRef = ref(storage, storagePath);

      await uploadBytes(fileRef, manualImportForm.file, {
        contentType: manualImportForm.file.type || "application/octet-stream",
        customMetadata: {
          hotelUid,
          fileType: selectedImportType.fileType,
          targetDateOverride: manualImportForm.targetDate,
          manualUpload: "true",
          fileImportTypeId: selectedImportType.id,
        },
      });

      setManualImportForm({ ...emptyManualImportForm, targetDate: manualImportForm.targetDate });
      setMessage("Import file uploaded. Processing will start automatically.");
    } catch (err) {
      console.error("Manual import upload failed", err);
      setError("Import file could not be uploaded.");
    } finally {
      setSaving(false);
    }
  };

  const handleSaveRule = async (event) => {
    event.preventDefault();
    const values = {
      minimumTargetRevenuePerOccupiedRoom: toNonNegativeFormNumber(ruleForm.minimumTargetRevenuePerOccupiedRoom),
      reachTargetRevenuePerOccupiedRoom: toNonNegativeFormNumber(ruleForm.reachTargetRevenuePerOccupiedRoom),
      stretchTargetRevenuePerOccupiedRoom: toNonNegativeFormNumber(ruleForm.stretchTargetRevenuePerOccupiedRoom),
    };

    if (!ruleForm.startDate || !ruleForm.endDate || ruleForm.startDate > ruleForm.endDate || Object.values(values).some((value) => value === null)) {
      setError("Choose a valid period and positive target values.");
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
      "Target rule saved in Firebase.",
      "Target rules could not be saved."
    );
    if (saved) setRuleForm(emptyRuleForm);
  };

  const occupancyDateKeys = getUpsellDateKeys(occupancyRange.startDate, occupancyRange.endDate);
  const occupancyMonths = occupancyDateKeys.reduce((months, dateKey) => {
    const monthKey = dateKey.slice(0, 7);
    months[monthKey] = [...(months[monthKey] || []), dateKey];
    return months;
  }, {});

  const packageRows = useMemo(() => packageCodes, [packageCodes]);

  const packageColumns = [
    { key: "packageCode", label: "Package Code" },
    { key: "category", label: "Category" },
    { key: "description", label: "Description" },
    {
      key: "actions",
      label: "Actions",
      sortable: false,
      render: (row) => (
        <button
          type="button"
          onClick={() => runSave(() => deleteUpsellPackageCode(hotelUid, row.id), "Package code deleted.", "Package code could not be deleted.")}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Trash2 className="h-4 w-4" /> Delete
        </button>
      ),
    },
  ];

  const ruleColumns = [
    { key: "startDate", label: "Start" },
    { key: "endDate", label: "End" },
    { key: "minimumTargetRevenuePerOccupiedRoom", label: "Minimum €/Occ. Room" },
    { key: "reachTargetRevenuePerOccupiedRoom", label: "Reach €/Occ. Room" },
    { key: "stretchTargetRevenuePerOccupiedRoom", label: "Stretch €/Occ. Room" },
    {
      key: "actions",
      label: "Actions",
      sortable: false,
      render: (row) => (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setRuleForm(row)} disabled={saving} className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
            Edit
          </button>
          <button
            type="button"
            onClick={() => runSave(() => saveUpsellRevenueTargetRules(hotelUid, revenueTargetRules.filter((rule) => rule.id !== row.id)), "Target rule deleted.", "Target rules could not be saved.")}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" /> Delete
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
            <p className="mt-1 text-gray-600">Manage daily expected occupancy and period-based revenue target rules.</p>
          </div>
          <button type="button" onClick={() => navigate("/front-office/upselling")} className="inline-flex h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50">
            Back to Upselling
          </button>
        </div>

        {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        {message && <div className="rounded-lg bg-green-50 p-3 text-sm text-green-700">{message}</div>}

        {loading ? (
          <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500 shadow-sm">Loading upsell settings...</div>
        ) : (
          <>
            <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <h2 className="text-lg font-semibold text-gray-900">Manual File Import</h2>
              <p className="mt-1 text-sm text-gray-500">Upload a file for a selected File Import Type. The chosen date overrides the Date Source configured on that type.</p>
              <form onSubmit={handleManualImportUpload} className="mt-4 grid gap-3 lg:grid-cols-[1fr_auto_1.5fr_auto] lg:items-end">
                <label className="text-sm font-semibold text-gray-700">
                  File Import Type
                  <select value={manualImportForm.fileImportTypeId} onChange={(event) => setManualImportForm((form) => ({ ...form, fileImportTypeId: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" disabled={saving}>
                    <option value="">Select a file import type</option>
                    {fileImportTypes.map((importType) => (
                      <option key={importType.id} value={importType.id}>{importType.fileType || importType.name || importType.id}</option>
                    ))}
                  </select>
                </label>
                <label className="text-sm font-semibold text-gray-700">
                  Import date
                  <input type="date" value={manualImportForm.targetDate} onChange={(event) => setManualImportForm((form) => ({ ...form, targetDate: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" disabled={saving} />
                </label>
                <label className="text-sm font-semibold text-gray-700">
                  File
                  <input type="file" onChange={(event) => setManualImportForm((form) => ({ ...form, file: event.target.files?.[0] || null }))} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" disabled={saving} />
                </label>
                <button type="submit" disabled={saving} className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white shadow hover:bg-[#961919] disabled:opacity-50"><Upload className="h-4 w-4" /> Upload import</button>
              </form>
            </section>

            <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
              <button type="button" onClick={() => setOccupancyOpen((open) => !open)} className="flex w-full items-center justify-between gap-3 p-4 text-left">
                <span>
                  <span className="block text-lg font-semibold text-gray-900">Expected Occupancy</span>
                  <span className="mt-1 block text-sm text-gray-500">Use the calendar to manage a compact period or apply the same occupancy to multiple days at once.</span>
                </span>
                <span className="text-sm font-semibold text-gray-600">{occupancyOpen ? "Collapse" : "Expand"}</span>
              </button>
              {occupancyOpen && <div className="border-t border-gray-100 p-4">
              <form onSubmit={handleBulkOccupancySave} className="mt-4 grid gap-3 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end">
                <label className="text-sm font-semibold text-gray-700">Start<input type="date" value={occupancyRange.startDate} onChange={(event) => setOccupancyRange((range) => ({ ...range, startDate: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
                <label className="text-sm font-semibold text-gray-700">End<input type="date" value={occupancyRange.endDate} onChange={(event) => setOccupancyRange((range) => ({ ...range, endDate: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
                <label className="text-sm font-semibold text-gray-700">Bulk occupancy<input type="number" min="0" step="1" value={bulkOccupancy} onChange={(event) => setBulkOccupancy(event.target.value)} placeholder="Rooms" className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
                <button type="submit" disabled={saving} className="rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white shadow hover:bg-[#961919] disabled:opacity-50">Apply</button>
              </form>
              <div className="mt-4 space-y-4">
                {Object.entries(occupancyMonths).map(([monthKey, dateKeys]) => (
                  <div key={monthKey}>
                    <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">{formatMonthLabel(`${monthKey}-01`)}</h3>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                      {dateKeys.map((dateKey) => (
                        <label key={dateKey} className="rounded-lg border border-gray-200 bg-gray-50 p-2 text-xs font-medium text-gray-600">
                          <span>{dateKey.slice(8, 10)}</span>
                          <input type="number" min="0" step="1" value={dailyExpectedOccupancy[dateKey] ?? ""} onChange={(event) => setDailyExpectedOccupancy((current) => ({ ...current, [dateKey]: event.target.value }))} onBlur={(event) => handleOccupancyCellSave(dateKey, event.target.value)} className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 text-sm text-gray-900" />
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              </div>}
            </section>

            <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <h2 className="text-lg font-semibold text-gray-900">Revenue Target Rules</h2>
              <p className="mt-1 text-sm text-gray-500">Targets apply to a full date range and are combined with daily expected occupancy.</p>
              <form onSubmit={handleSaveRule} className="mt-4 grid gap-3 md:grid-cols-3 xl:grid-cols-6 xl:items-end">
                <label className="text-sm font-semibold text-gray-700">Start<input type="date" value={ruleForm.startDate} onChange={(event) => setRuleForm((form) => ({ ...form, startDate: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
                <label className="text-sm font-semibold text-gray-700">End<input type="date" value={ruleForm.endDate} onChange={(event) => setRuleForm((form) => ({ ...form, endDate: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
                <label className="text-sm font-semibold text-gray-700">Minimum<input type="number" min="0" step="0.01" value={ruleForm.minimumTargetRevenuePerOccupiedRoom} onChange={(event) => setRuleForm((form) => ({ ...form, minimumTargetRevenuePerOccupiedRoom: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
                <label className="text-sm font-semibold text-gray-700">Reach<input type="number" min="0" step="0.01" value={ruleForm.reachTargetRevenuePerOccupiedRoom} onChange={(event) => setRuleForm((form) => ({ ...form, reachTargetRevenuePerOccupiedRoom: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
                <label className="text-sm font-semibold text-gray-700">Stretch<input type="number" min="0" step="0.01" value={ruleForm.stretchTargetRevenuePerOccupiedRoom} onChange={(event) => setRuleForm((form) => ({ ...form, stretchTargetRevenuePerOccupiedRoom: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
                <button type="submit" disabled={saving} className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white shadow hover:bg-[#961919] disabled:opacity-50"><Plus className="h-4 w-4" /> Save rule</button>
              </form>
              <div className="mt-4"><DataListTable columns={ruleColumns} rows={revenueTargetRules} emptyMessage="No revenue target rules added yet." /></div>
            </section>

            <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <form onSubmit={handleAddPackageCode}>
                <label htmlFor="package-code" className="block text-sm font-semibold text-gray-700">Add package code</label>
                <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-[1fr_1fr_2fr_auto] xl:items-end">
                  <input id="package-code" type="text" value={packageCodeForm.packageCode} onChange={(event) => setPackageCodeForm((form) => ({ ...form, packageCode: event.target.value }))} placeholder="E.g. PKG_BREAKFAST" className="min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm uppercase" disabled={saving} />
                  <input type="text" value={packageCodeForm.category} onChange={(event) => setPackageCodeForm((form) => ({ ...form, category: event.target.value }))} placeholder="Category" className="min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" disabled={saving} />
                  <input type="text" value={packageCodeForm.description} onChange={(event) => setPackageCodeForm((form) => ({ ...form, description: event.target.value }))} placeholder="Description" className="min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" disabled={saving} />
                  <button type="submit" disabled={saving} className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white shadow hover:bg-[#961919] disabled:opacity-50"><Plus className="h-4 w-4" /> Add</button>
                </div>
              </form>
              <div className="mt-4"><DataListTable columns={packageColumns} rows={packageRows} emptyMessage="No package codes added yet." /></div>
            </section>
          </>
        )}
      </PageContainer>
    </div>
  );
}
