import React, { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCcw } from "lucide-react";
import { signOut, auth } from "../../firebaseConfig";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { useHotelContext } from "../../contexts/HotelContext";
import { getPickupForMonth } from "../../services/firebasePickup";

function formatMonthLabel(date) {
  return date.toLocaleDateString("nl-BE", { month: "long", year: "numeric" });
}

function formatCurrency(value) {
  return new Intl.NumberFormat("nl-BE", { style: "currency", currency: "EUR" }).format(value || 0);
}

function formatDisplayDate(isoDate) {
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString("nl-BE", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  });
}

export default function PickupPage() {
  const { hotelUid } = useHotelContext();
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  useEffect(() => {
    let active = true;

    async function loadPickup() {
      if (!hotelUid) {
        setRows([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError("");
      try {
        const result = await getPickupForMonth(hotelUid, selectedMonth);
        if (active) {
          setRows(result);
        }
      } catch (fetchError) {
        console.error("Fout bij ophalen van pick-up:", fetchError);
        if (active) {
          setRows([]);
          setError("De pick-up kon niet geladen worden. Controleer de Firestore-structuur en probeer opnieuw.");
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    loadPickup();
    return () => {
      active = false;
    };
  }, [hotelUid, selectedMonth]);

  const totals = useMemo(() => rows.reduce((acc, row) => ({
    roomsSold: acc.roomsSold + row.roomsSold,
    totalRevenue: acc.totalRevenue + row.totalRevenue,
  }), { roomsSold: 0, totalRevenue: 0 }), [rows]);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <Card className="space-y-4">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h1 className="text-2xl font-semibold text-gray-900">Pick-Up</h1>
              <p className="mt-2 text-sm text-gray-600">
                Business on the books per dag van de geselecteerde maand, met historische data uit reservationstatistics en toekomstige data uit reservationforecast.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setSelectedMonth((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1))}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
              >
                <ChevronLeft className="h-4 w-4" />
                Vorige maand
              </button>
              <div className="min-w-40 rounded-lg bg-red-50 px-4 py-2 text-center text-sm font-semibold text-[#b41f1f]">
                {formatMonthLabel(selectedMonth)}
              </div>
              <button
                type="button"
                onClick={() => setSelectedMonth((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1))}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
              >
                Volgende maand
                <ChevronRight className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setSelectedMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}
                className="inline-flex items-center gap-2 rounded-lg border border-transparent bg-[#b41f1f] px-3 py-2 text-sm font-semibold text-white hover:bg-[#991b1b]"
              >
                <RefreshCcw className="h-4 w-4" />
                Huidige maand
              </button>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-xl bg-gray-50 p-4">
              <div className="text-sm text-gray-500">Totaal rooms sold</div>
              <div className="mt-1 text-3xl font-semibold text-gray-900">{totals.roomsSold}</div>
            </div>
            <div className="rounded-xl bg-gray-50 p-4">
              <div className="text-sm text-gray-500">Totaal revenue</div>
              <div className="mt-1 text-3xl font-semibold text-gray-900">{formatCurrency(totals.totalRevenue)}</div>
            </div>
          </div>
        </Card>

        <Card className="overflow-hidden">
          {loading ? (
            <div className="py-16 text-center text-sm text-gray-500">Pick-up laden...</div>
          ) : error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">Datum</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">Rooms sold</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">Total revenue</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">Bron</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {rows.map((row) => (
                    <tr key={row.date}>
                      <td className="whitespace-nowrap px-4 py-3 text-sm font-medium text-gray-900">{formatDisplayDate(row.date)}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-right text-sm text-gray-700">{row.roomsSold}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-right text-sm text-gray-700">{formatCurrency(row.totalRevenue)}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500">
                        {row.source === "reservationstatistics" ? "Reservation statistics" : "Reservation forecast"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </PageContainer>
    </div>
  );
}
