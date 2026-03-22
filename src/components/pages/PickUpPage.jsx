import React, { useEffect, useMemo, useState } from "react";
import { signOut, auth } from "../../firebaseConfig";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import DataListTable from "../shared/DataListTable";
import { useHotelContext } from "../../contexts/HotelContext";
import { getLatestPickUpRows } from "../../services/firebasePickUp";

export default function PickUpPage() {
  const { hotelUid } = useHotelContext();
  const [selectedMonth, setSelectedMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [forecastSnapshotDate, setForecastSnapshotDate] = useState(null);
  const [previousForecastSnapshotDate, setPreviousForecastSnapshotDate] = useState(null);
  const [statisticsSnapshotDate, setStatisticsSnapshotDate] = useState(null);
  const [previousStatisticsSnapshotDate, setPreviousStatisticsSnapshotDate] = useState(null);
  const [totals, setTotals] = useState({
    totalRoomsSold: 0,
    totalRevenue: 0,
    totalCalculatedRevenue: 0,
  });
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  useEffect(() => {
    let active = true;

    async function loadPickUp() {
      if (!hotelUid) {
        setRows([]);
        setForecastSnapshotDate(null);
        setPreviousForecastSnapshotDate(null);
        setStatisticsSnapshotDate(null);
        setPreviousStatisticsSnapshotDate(null);
        setTotals({ totalRoomsSold: 0, totalRevenue: 0, totalCalculatedRevenue: 0 });
        setLoading(false);
        return;
      }

      setLoading(true);
      setError("");

      try {
        const result = await getLatestPickUpRows(hotelUid, selectedMonth);
        if (!active) return;
        setRows(result.rows);
        setForecastSnapshotDate(result.forecastSnapshotDate);
        setPreviousForecastSnapshotDate(result.previousForecastSnapshotDate);
        setStatisticsSnapshotDate(result.statisticsSnapshotDate);
        setPreviousStatisticsSnapshotDate(result.previousStatisticsSnapshotDate);
        setTotals(result.totals);
      } catch (err) {
        console.error("Fout bij laden van pick-up data:", err);
        if (!active) return;
        setError("De pick-up data kon niet geladen worden.");
        setRows([]);
        setForecastSnapshotDate(null);
        setPreviousForecastSnapshotDate(null);
        setStatisticsSnapshotDate(null);
        setPreviousStatisticsSnapshotDate(null);
        setTotals({ totalRoomsSold: 0, totalRevenue: 0, totalCalculatedRevenue: 0 });
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    loadPickUp();

    return () => {
      active = false;
    };
  }, [hotelUid, selectedMonth]);

  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  const columns = useMemo(
    () => [
      { key: "stayDate", label: "Stay Date" },
      {
        key: "roomsSold",
        label: "Rooms Sold",
        render: (row) => row.roomsSold.toLocaleString(),
      },
      {
        key: "roomsSoldDelta",
        label: "Δ vs day -1",
        render: (row) => {
          const prefix = row.roomsSoldDelta > 0 ? "+" : "";
          const colorClass = row.roomsSoldDelta > 0
            ? "text-green-600"
            : row.roomsSoldDelta < 0
              ? "text-red-600"
              : "text-gray-600";

          return (
            <span className={colorClass}>
              {prefix}
              {row.roomsSoldDelta.toLocaleString()}
            </span>
          );
        },
      },
      {
        key: "totalRevenue",
        label: "Total Revenue",
        render: (row) => row.totalRevenue.toLocaleString(undefined, {
          style: "currency",
          currency: "EUR",
        }),
      },
      {
        key: "totalCalculatedRevenue",
        label: "Total Calculated Revenue",
        render: (row) => row.totalCalculatedRevenue.toLocaleString(undefined, {
          style: "currency",
          currency: "EUR",
        }),
      },
    ],
    []
  );

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer>
        <Card className="space-y-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h1 className="text-2xl font-semibold text-gray-900">Pick-Up</h1>
              <p className="mt-2 text-sm text-gray-600">
                Business on the books per stay date. Verleden dagen gebruiken reservation
                statistics, vandaag en toekomst gebruiken reservation forecast. De rooms sold
                delta vergelijkt telkens met de vorige snapshotdag.
              </p>
            </div>
            <div className="rounded-lg bg-gray-100 px-4 py-3 text-sm text-gray-700 space-y-1">
              <div>
                <span className="font-semibold">Forecast Snapshot:</span>{" "}
                {forecastSnapshotDate || "Geen snapshot beschikbaar"}{previousForecastSnapshotDate ? ` (vorige: ${previousForecastSnapshotDate})` : ""}
              </div>
              <div>
                <span className="font-semibold">Statistics Snapshot:</span>{" "}
                {statisticsSnapshotDate || "Geen snapshot beschikbaar"}{previousStatisticsSnapshotDate ? ` (vorige: ${previousStatisticsSnapshotDate})` : ""}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <label htmlFor="pickup-month" className="block text-sm font-semibold text-gray-700">
                Month
              </label>
              <input
                id="pickup-month"
                type="month"
                value={selectedMonth}
                onChange={(event) => setSelectedMonth(event.target.value)}
                className="mt-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-3 w-full lg:w-auto">
              <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm">
                <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Total Revenue
                </div>
                <div className="mt-1 text-lg font-semibold text-gray-900">
                  {totals.totalRevenue.toLocaleString(undefined, { style: "currency", currency: "EUR" })}
                </div>
              </div>
              <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm">
                <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Total Rooms Sold
                </div>
                <div className="mt-1 text-lg font-semibold text-gray-900">
                  {totals.totalRoomsSold.toLocaleString()}
                </div>
              </div>
              <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm">
                <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Total Calculated Revenue
                </div>
                <div className="mt-1 text-lg font-semibold text-gray-900">
                  {totals.totalCalculatedRevenue.toLocaleString(undefined, { style: "currency", currency: "EUR" })}
                </div>
              </div>
            </div>
          </div>

          {error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          ) : null}

          {loading ? (
            <div className="py-10 text-center text-sm text-gray-500">Pick-up data wordt geladen...</div>
          ) : (
            <DataListTable
              columns={columns}
              rows={rows}
              emptyMessage="Geen pick-up records gevonden voor de meest recente snapshot."
            />
          )}
        </Card>
      </PageContainer>
    </div>
  );
}
