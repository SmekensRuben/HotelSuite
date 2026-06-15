import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Trash2 } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import {
  getUpsellSettings,
  saveUpsellDailyRevenueTargets,
  saveUpsellPackageCodes,
} from "../../services/firebaseUpsells";

const emptyDailyTargetForm = {
  dateKey: "",
  expectedOccupancy: "",
  minimumRevenuePerOccupiedRoom: "",
  reachRevenuePerOccupiedRoom: "",
  stretchRevenuePerOccupiedRoom: "",
};

function toInputNumber(value) {
  return value === undefined || value === null ? "" : String(value);
}

function normalizeDailyTargetForm(form) {
  return {
    expectedOccupancy: Number(form.expectedOccupancy || 0),
    minimumRevenuePerOccupiedRoom: Number(form.minimumRevenuePerOccupiedRoom || 0),
    reachRevenuePerOccupiedRoom: Number(form.reachRevenuePerOccupiedRoom || 0),
    stretchRevenuePerOccupiedRoom: Number(form.stretchRevenuePerOccupiedRoom || 0),
  };
}

export default function UpsellSettingsPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [packageCodes, setPackageCodes] = useState([]);
  const [dailyRevenueTargets, setDailyRevenueTargets] = useState({});
  const [newPackageCode, setNewPackageCode] = useState("");
  const [dailyTargetForm, setDailyTargetForm] = useState(emptyDailyTargetForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
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

    async function loadSettings() {
      if (!hotelUid) {
        setPackageCodes([]);
        setDailyRevenueTargets({});
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
        setDailyRevenueTargets(settings.dailyRevenueTargets || {});
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

  const persistPackageCodes = async (nextPackageCodes) => {
    if (!hotelUid) {
      setError("Geen hotel geselecteerd om package codes op te slaan.");
      return false;
    }

    setSaving(true);
    setError("");
    setMessage("");

    try {
      await saveUpsellPackageCodes(hotelUid, nextPackageCodes);
      const refreshedSettings = await getUpsellSettings(hotelUid);
      setPackageCodes(refreshedSettings.packageCodes || []);
      setMessage("Package codes opgeslagen in Firebase.");
      return true;
    } catch (err) {
      console.error("Failed to save upsell package codes", err);
      setError("Package codes konden niet opgeslagen worden.");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const persistDailyRevenueTargets = async (nextDailyRevenueTargets) => {
    if (!hotelUid) {
      setError("Geen hotel geselecteerd om revenue targets op te slaan.");
      return false;
    }

    setSaving(true);
    setError("");
    setMessage("");

    try {
      await saveUpsellDailyRevenueTargets(hotelUid, nextDailyRevenueTargets);
      const refreshedSettings = await getUpsellSettings(hotelUid);
      setDailyRevenueTargets(refreshedSettings.dailyRevenueTargets || {});
      setMessage("Daily revenue targets opgeslagen in Firebase.");
      return true;
    } catch (err) {
      console.error("Failed to save upsell revenue targets", err);
      setError("Daily revenue targets konden niet opgeslagen worden.");
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

    const saved = await persistPackageCodes([...packageCodes, normalizedCode]);
    if (saved) setNewPackageCode("");
  };

  const handleRemovePackageCode = (packageCode) => {
    persistPackageCodes(packageCodes.filter((code) => code !== packageCode));
  };

  const handleDailyTargetChange = (field, value) => {
    setDailyTargetForm((currentForm) => ({ ...currentForm, [field]: value }));
  };

  const handleEditDailyTarget = (row) => {
    setDailyTargetForm({
      dateKey: row.dateKey,
      expectedOccupancy: toInputNumber(row.expectedOccupancy),
      minimumRevenuePerOccupiedRoom: toInputNumber(row.minimumRevenuePerOccupiedRoom),
      reachRevenuePerOccupiedRoom: toInputNumber(row.reachRevenuePerOccupiedRoom),
      stretchRevenuePerOccupiedRoom: toInputNumber(row.stretchRevenuePerOccupiedRoom),
    });
  };

  const handleSaveDailyTarget = async (event) => {
    event.preventDefault();

    if (!dailyTargetForm.dateKey) {
      setError("Kies een datum voor de daily revenue target.");
      return;
    }

    const values = normalizeDailyTargetForm(dailyTargetForm);
    const hasInvalidValue = Object.values(values).some((value) => !Number.isFinite(value) || value < 0);
    if (hasInvalidValue) {
      setError("Vul enkel positieve cijfers in voor occupancy en targets.");
      return;
    }

    const saved = await persistDailyRevenueTargets({
      ...dailyRevenueTargets,
      [dailyTargetForm.dateKey]: values,
    });
    if (saved) setDailyTargetForm(emptyDailyTargetForm);
  };

  const handleRemoveDailyTarget = (dateKey) => {
    const { [dateKey]: removedTarget, ...remainingTargets } = dailyRevenueTargets;
    persistDailyRevenueTargets(remainingTargets);
  };

  const packageRows = useMemo(
    () => packageCodes.map((packageCode) => ({ id: packageCode, packageCode })),
    [packageCodes]
  );

  const dailyTargetRows = useMemo(
    () =>
      Object.entries(dailyRevenueTargets)
        .map(([dateKey, target]) => ({ id: dateKey, dateKey, ...target }))
        .sort((a, b) => a.dateKey.localeCompare(b.dateKey)),
    [dailyRevenueTargets]
  );

  const packageColumns = [
    { key: "packageCode", label: "Package Code" },
    {
      key: "actions",
      label: "Acties",
      sortable: false,
      render: (row) => (
        <button
          type="button"
          onClick={() => handleRemovePackageCode(row.packageCode)}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Trash2 className="h-4 w-4" /> Verwijderen
        </button>
      ),
    },
  ];

  const dailyTargetColumns = [
    { key: "dateKey", label: "Dag" },
    { key: "expectedOccupancy", label: "Expected Occupancy" },
    { key: "minimumRevenuePerOccupiedRoom", label: "Minimum €/Occ. Room" },
    { key: "reachRevenuePerOccupiedRoom", label: "Reach €/Occ. Room" },
    { key: "stretchRevenuePerOccupiedRoom", label: "Stretch €/Occ. Room" },
    {
      key: "actions",
      label: "Acties",
      sortable: false,
      render: (row) => (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => handleEditDailyTarget(row)}
            disabled={saving}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Bewerken
          </button>
          <button
            type="button"
            onClick={() => handleRemoveDailyTarget(row.dateKey)}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
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
            <p className="mt-1 text-gray-600">
              Beheer package codes, expected occupancy en revenue targets per occupied room.
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate("/front-office/upselling")}
            className="inline-flex h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Terug naar Upselling
          </button>
        </div>

        <form onSubmit={handleSaveDailyTarget} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900">Daily Revenue Target</h2>
          <p className="mt-1 text-sm text-gray-500">
            Stel per dag het aantal verwachte bezette kamers en de target revenue per occupied room in.
          </p>
          <div className="mt-4 grid gap-3 md:grid-cols-5">
            <label className="text-sm font-semibold text-gray-700">
              Dag
              <input
                type="date"
                value={dailyTargetForm.dateKey}
                onChange={(event) => handleDailyTargetChange("dateKey", event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
                disabled={saving}
              />
            </label>
            <label className="text-sm font-semibold text-gray-700">
              Expected Occupancy
              <input
                type="number"
                min="0"
                step="1"
                value={dailyTargetForm.expectedOccupancy}
                onChange={(event) => handleDailyTargetChange("expectedOccupancy", event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
                disabled={saving}
              />
            </label>
            <label className="text-sm font-semibold text-gray-700">
              Minimum €/Occ. Room
              <input
                type="number"
                min="0"
                step="0.01"
                value={dailyTargetForm.minimumRevenuePerOccupiedRoom}
                onChange={(event) => handleDailyTargetChange("minimumRevenuePerOccupiedRoom", event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
                disabled={saving}
              />
            </label>
            <label className="text-sm font-semibold text-gray-700">
              Reach €/Occ. Room
              <input
                type="number"
                min="0"
                step="0.01"
                value={dailyTargetForm.reachRevenuePerOccupiedRoom}
                onChange={(event) => handleDailyTargetChange("reachRevenuePerOccupiedRoom", event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
                disabled={saving}
              />
            </label>
            <label className="text-sm font-semibold text-gray-700">
              Stretch €/Occ. Room
              <input
                type="number"
                min="0"
                step="0.01"
                value={dailyTargetForm.stretchRevenuePerOccupiedRoom}
                onChange={(event) => handleDailyTargetChange("stretchRevenuePerOccupiedRoom", event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
                disabled={saving}
              />
            </label>
          </div>
          <button
            type="submit"
            disabled={saving}
            className="mt-4 inline-flex items-center justify-center gap-2 rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white shadow hover:bg-[#961919] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus className="h-4 w-4" /> Target opslaan
          </button>
        </form>

        <form onSubmit={handleAddPackageCode} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <label htmlFor="package-code" className="block text-sm font-semibold text-gray-700">
            Package Code toevoegen
          </label>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              id="package-code"
              type="text"
              value={newPackageCode}
              onChange={(event) => setNewPackageCode(event.target.value)}
              placeholder="Bijv. PKG_BREAKFAST"
              className="min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm uppercase focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
              disabled={saving}
            />
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white shadow hover:bg-[#961919] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-4 w-4" /> Toevoegen
            </button>
          </div>
        </form>

        {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        {message && <div className="rounded-lg bg-green-50 p-3 text-sm text-green-700">{message}</div>}

        {loading ? (
          <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500 shadow-sm">
            Upsell settings worden geladen...
          </div>
        ) : (
          <div className="space-y-6">
            <DataListTable columns={dailyTargetColumns} rows={dailyTargetRows} emptyMessage="Nog geen daily revenue targets toegevoegd." />
            <DataListTable columns={packageColumns} rows={packageRows} emptyMessage="Nog geen package codes toegevoegd." />
          </div>
        )}
      </PageContainer>
    </div>
  );
}
