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
  const [snapshotDate, setSnapshotDate] = useState(null);
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
        setSnapshotDate(null);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError("");

      try {
        const result = await getLatestPickUpRows(hotelUid);
        if (!active) return;
        setRows(result.rows);
        setSnapshotDate(result.snapshotDate);
      } catch (err) {
        console.error("Fout bij laden van pick-up data:", err);
        if (!active) return;
        setError("De pick-up data kon niet geladen worden.");
        setRows([]);
        setSnapshotDate(null);
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
                Business on the books op basis van de meest recente reservation forecast snapshot.
              </p>
            </div>
            <div className="rounded-lg bg-gray-100 px-4 py-3 text-sm text-gray-700">
              <span className="font-semibold">Snapshot Date:</span>{" "}
              {snapshotDate || "Geen snapshot beschikbaar"}
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
