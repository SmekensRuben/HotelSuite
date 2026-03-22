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
  const [forecastSnapshotDate, setForecastSnapshotDate] = useState(null);
  const [statisticsSnapshotDate, setStatisticsSnapshotDate] = useState(null);
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
        setStatisticsSnapshotDate(null);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError("");

      try {
        const result = await getLatestPickUpRows(hotelUid);
        if (!active) return;
        setRows(result.rows);
        setForecastSnapshotDate(result.forecastSnapshotDate);
        setStatisticsSnapshotDate(result.statisticsSnapshotDate);
      } catch (err) {
        console.error("Fout bij laden van pick-up data:", err);
        if (!active) return;
        setError("De pick-up data kon niet geladen worden.");
        setRows([]);
        setForecastSnapshotDate(null);
        setStatisticsSnapshotDate(null);
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
  }, [hotelUid]);

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
        key: "totalRevenue",
        label: "Total Revenue",
        render: (row) => row.totalRevenue.toLocaleString(undefined, {
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
                Business on the books voor de stay dates van deze maand. Verleden dagen
                gebruiken reservation statistics, vandaag en toekomst gebruiken reservation
                forecast.
              </p>
            </div>
            <div className="rounded-lg bg-gray-100 px-4 py-3 text-sm text-gray-700 space-y-1">
              <div>
                <span className="font-semibold">Forecast Snapshot:</span>{" "}
                {forecastSnapshotDate || "Geen snapshot beschikbaar"}
              </div>
              <div>
                <span className="font-semibold">Statistics Snapshot:</span>{" "}
                {statisticsSnapshotDate || "Geen snapshot beschikbaar"}
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
