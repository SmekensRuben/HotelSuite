import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Trash2 } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getUpsellSettings, saveUpsellPackageCodes } from "../../services/firebaseUpsells";

export default function UpsellSettingsPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [packageCodes, setPackageCodes] = useState([]);
  const [newPackageCode, setNewPackageCode] = useState("");
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

  const rows = useMemo(
    () => packageCodes.map((packageCode) => ({ id: packageCode, packageCode })),
    [packageCodes]
  );

  const columns = [
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

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm uppercase tracking-wide text-gray-500">Front Office</p>
            <h1 className="text-3xl font-semibold">Upsell Settings</h1>
            <p className="mt-1 text-gray-600">
              Beheer de package codes die later bepalen welke upsells getoond worden.
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
            Package codes worden geladen...
          </div>
        ) : (
          <DataListTable columns={columns} rows={rows} emptyMessage="Nog geen package codes toegevoegd." />
        )}
      </PageContainer>
    </div>
  );
}
