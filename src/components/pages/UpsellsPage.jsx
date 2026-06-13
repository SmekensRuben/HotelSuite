import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Settings } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getUpsellSettings } from "../../services/firebaseUpsells";

export default function UpsellsPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [packageCodes, setPackageCodes] = useState([]);
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

    async function loadUpsellSettings() {
      if (!hotelUid) {
        setPackageCodes([]);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError("");

      try {
        const settings = await getUpsellSettings(hotelUid);
        if (!active) return;
        setPackageCodes(settings.packageCodes || []);
      } catch (err) {
        console.error("Failed to load upsell settings", err);
        if (!active) return;
        setError("Upsell instellingen konden niet geladen worden.");
      } finally {
        if (active) setLoading(false);
      }
    }

    loadUpsellSettings();

    return () => {
      active = false;
    };
  }, [hotelUid]);

  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  const rows = useMemo(
    () =>
      packageCodes.map((packageCode) => ({
        id: packageCode,
        packageCode,
        status: "Geconfigureerd",
      })),
    [packageCodes]
  );

  const columns = [
    { key: "packageCode", label: "Package Code" },
    {
      key: "status",
      label: "Status",
      render: (row) => (
        <span className="inline-flex rounded-full bg-blue-100 px-2 py-1 text-xs font-semibold text-blue-700">
          {row.status}
        </span>
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
            <h1 className="text-3xl font-semibold">Upselling</h1>
            <p className="mt-1 text-gray-600">
              Overzicht van upsells op basis van de geconfigureerde package codes.
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

        {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        {loading ? (
          <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500 shadow-sm">
            Upsells worden geladen...
          </div>
        ) : (
          <DataListTable
            columns={columns}
            rows={rows}
            emptyMessage="Nog geen upsells gevonden. Voeg eerst package codes toe via de settings."
          />
        )}
      </PageContainer>
    </div>
  );
}
