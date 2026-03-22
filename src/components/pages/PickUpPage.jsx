import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Info, Send } from "lucide-react";
import { signOut, auth } from "../../firebaseConfig";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import DataListTable from "../shared/DataListTable";
import { useHotelContext } from "../../contexts/HotelContext";
import { getLatestPickUpRows } from "../../services/firebasePickUp";
import { triggerScheduledOccupancyMail } from "../../services/firebaseScheduledOccupancy";
import { getSettings } from "../../services/firebaseSettings";

function formatCurrency(value) {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "EUR",
  });
}

function getDeltaTextClass(value) {
  if (value > 0) return "text-green-600";
  if (value < 0) return "text-red-600";
  return "text-gray-600";
}

function renderSignedValue(value, formatter = (nextValue) => nextValue.toLocaleString()) {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${formatter(value)}`;
}

function formatPercentage(value) {
  return `${value.toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}

export default function PickUpPage() {
  const { hotelUid } = useHotelContext();
  const [selectedMonth, setSelectedMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [selectedMarketCodes, setSelectedMarketCodes] = useState([]);
  const [availableMarketCodes, setAvailableMarketCodes] = useState([]);
  const [availableSnapshotDates, setAvailableSnapshotDates] = useState([]);
  const [selectedSnapshotDate, setSelectedSnapshotDate] = useState("");
  const [pickupComparisonDaysInput, setPickupComparisonDaysInput] = useState("1");
  const [hotelRooms, setHotelRooms] = useState(0);
  const [marketCodeDropdownOpen, setMarketCodeDropdownOpen] = useState(false);
  const [snapshotInfoOpen, setSnapshotInfoOpen] = useState(false);
  const [forecastSnapshotDate, setForecastSnapshotDate] = useState(null);
  const [previousForecastSnapshotDate, setPreviousForecastSnapshotDate] = useState(null);
  const [statisticsSnapshotDate, setStatisticsSnapshotDate] = useState(null);
  const [previousStatisticsSnapshotDate, setPreviousStatisticsSnapshotDate] = useState(null);
  const [totals, setTotals] = useState({
    totalRoomsSold: 0,
    totalCalculatedRevenue: 0,
    previousTotalRoomsSold: 0,
    previousTotalCalculatedRevenue: 0,
  });
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [manualTriggerLoading, setManualTriggerLoading] = useState(false);
  const [manualTriggerMessage, setManualTriggerMessage] = useState("");
  const marketCodesRef = useRef(null);

  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  useEffect(() => {
    function handleClickOutside(event) {
      if (marketCodesRef.current && !marketCodesRef.current.contains(event.target)) {
        setMarketCodeDropdownOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    let active = true;

    async function loadPickUp() {
      if (!hotelUid) {
        setRows([]);
        setAvailableMarketCodes([]);
        setAvailableSnapshotDates([]);
        setSelectedMarketCodes([]);
        setSelectedSnapshotDate("");
        setHotelRooms(0);
        setForecastSnapshotDate(null);
        setPreviousForecastSnapshotDate(null);
        setStatisticsSnapshotDate(null);
        setPreviousStatisticsSnapshotDate(null);
        setTotals({
          totalRoomsSold: 0,
          totalCalculatedRevenue: 0,
          previousTotalRoomsSold: 0,
          previousTotalCalculatedRevenue: 0,
        });
        setLoading(false);
        return;
      }

      setLoading(true);
      setError("");

      try {
        const normalizedPickupComparisonDays = Math.max(
          1,
          Math.floor(Number(pickupComparisonDaysInput) || 1)
        );
        const [result, settings] = await Promise.all([
          getLatestPickUpRows(
            hotelUid,
            selectedMonth,
            selectedMarketCodes,
            normalizedPickupComparisonDays,
            selectedSnapshotDate || null
          ),
          getSettings(hotelUid),
        ]);
        if (!active) return;
        setRows(result.rows);
        setAvailableMarketCodes(result.availableMarketCodes);
        setAvailableSnapshotDates(result.availableSnapshotDates || []);
        setSelectedSnapshotDate(result.selectedSnapshotDate || "");
        setPickupComparisonDaysInput(String(result.pickupComparisonDays));
        setHotelRooms(Number(settings?.hotelRooms) || 0);
        setForecastSnapshotDate(result.forecastSnapshotDate);
        setPreviousForecastSnapshotDate(result.previousForecastSnapshotDate);
        setStatisticsSnapshotDate(result.statisticsSnapshotDate);
        setPreviousStatisticsSnapshotDate(result.previousStatisticsSnapshotDate);
        setTotals(result.totals);
        setSelectedMarketCodes((currentSelection) => {
          const nextSelection = currentSelection.filter((marketCode) =>
            result.availableMarketCodes.includes(marketCode)
          );
          return nextSelection.length === currentSelection.length &&
            nextSelection.every((marketCode, index) => marketCode === currentSelection[index])
            ? currentSelection
            : nextSelection;
        });
      } catch (err) {
        console.error("Fout bij laden van pick-up data:", err);
        if (!active) return;
        setError("De pick-up data kon niet geladen worden.");
        setRows([]);
        setHotelRooms(0);
        setAvailableMarketCodes([]);
        setAvailableSnapshotDates([]);
        setForecastSnapshotDate(null);
        setPreviousForecastSnapshotDate(null);
        setStatisticsSnapshotDate(null);
        setPreviousStatisticsSnapshotDate(null);
        setTotals({
          totalRoomsSold: 0,
          totalCalculatedRevenue: 0,
          previousTotalRoomsSold: 0,
          previousTotalCalculatedRevenue: 0,
        });
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
  }, [hotelUid, selectedMonth, selectedMarketCodes, pickupComparisonDaysInput, selectedSnapshotDate]);

  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  const toggleMarketCode = (marketCode) => {
    setSelectedMarketCodes((currentSelection) =>
      currentSelection.includes(marketCode)
        ? currentSelection.filter((currentMarketCode) => currentMarketCode !== marketCode)
        : [...currentSelection, marketCode]
    );
  };

  const clearMarketCodeFilter = () => {
    setSelectedMarketCodes([]);
  };

  const pickupComparisonDays = Math.max(1, Math.floor(Number(pickupComparisonDaysInput) || 1));
  const totalRoomsSoldPickup = totals.totalRoomsSold - totals.previousTotalRoomsSold;
  const totalCalculatedRevenuePickup =
    totals.totalCalculatedRevenue - totals.previousTotalCalculatedRevenue;
  const marketCodeButtonLabel = selectedMarketCodes.length
    ? `Market Codes (${selectedMarketCodes.length})`
    : "Market Codes";


  const handleManualOccupancyMailTrigger = async () => {
    if (manualTriggerLoading) return;

    setManualTriggerLoading(true);
    setManualTriggerMessage("");

    try {
      const triggerId = await triggerScheduledOccupancyMail({
        hotelUid,
        requestedBy: auth.currentUser?.email || auth.currentUser?.uid || null,
      });
      setManualTriggerMessage(`Occupancy mail staat in de wachtrij. Trigger ID: ${triggerId}`);
    } catch (err) {
      console.error("Fout bij manueel triggeren van occupancy mail:", err);
      setManualTriggerMessage("De occupancy mail kon niet manueel gestart worden.");
    } finally {
      setManualTriggerLoading(false);
    }
  };

  const columns = useMemo(
    () => [
      { key: "stayDate", label: "Stay Date" },
      {
        key: "occupancy",
        label: "Occupancy",
        render: (row) => {
          const occupancy = hotelRooms > 0 ? (row.roomsSold / hotelRooms) * 100 : 0;
          return formatPercentage(occupancy);
        },
        sortValue: (row) => (hotelRooms > 0 ? (row.roomsSold / hotelRooms) * 100 : 0),
      },
      {
        key: "roomsSold",
        label: "Rooms Sold",
        render: (row) => row.roomsSold.toLocaleString(),
      },
      {
        key: "avgAdr",
        label: "Avg ADR",
        render: (row) => formatCurrency(row.avgAdr),
      },
      {
        key: "roomsSoldDelta",
        label: `Rooms Sold -${pickupComparisonDays}`,
        render: (row) => (
          <span className={getDeltaTextClass(row.roomsSoldDelta)}>
            {renderSignedValue(row.roomsSoldDelta)}
          </span>
        ),
      },
      {
        key: "avgAdrDelta",
        label: `Avg ADR -${pickupComparisonDays}`,
        render: (row) => (
          <span className={getDeltaTextClass(row.avgAdrDelta)}>
            {renderSignedValue(row.avgAdrDelta, formatCurrency)}
          </span>
        ),
      },
    ],
    [hotelRooms, pickupComparisonDays]
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
                statistics, vandaag en toekomst gebruiken reservation forecast. Als de eerdere
                statistics-snapshot de recentste stay date nog niet bevat, gebruiken we voor die
                vergelijking de reservation forecast van dezelfde vergelijkingsdag.
              </p>
            </div>
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={handleManualOccupancyMailTrigger}
                disabled={manualTriggerLoading}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
              >
                <Send size={16} />
                {manualTriggerLoading ? "Occupancy mail starten..." : "Verstuur occupancy PDF"}
              </button>
              <div
              className="relative flex justify-end"
              onMouseEnter={() => setSnapshotInfoOpen(true)}
              onMouseLeave={() => setSnapshotInfoOpen(false)}
            >
              <button
                type="button"
                className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-gray-100 text-gray-600 transition hover:bg-gray-200 hover:text-gray-900"
                aria-label="Toon snapshotinformatie"
                onFocus={() => setSnapshotInfoOpen(true)}
                onBlur={() => setSnapshotInfoOpen(false)}
              >
                <Info size={18} />
              </button>
              {snapshotInfoOpen ? (
                <div className="absolute right-0 top-12 z-10 w-80 rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-700 shadow-lg">
                  <div>
                    <span className="font-semibold">Forecast Snapshot:</span>{" "}
                    {forecastSnapshotDate || "Geen snapshot beschikbaar"}
                    {previousForecastSnapshotDate ? ` (vergelijking: ${previousForecastSnapshotDate})` : ""}
                  </div>
                  <div className="mt-2">
                    <span className="font-semibold">Statistics Snapshot:</span>{" "}
                    {statisticsSnapshotDate || "Geen snapshot beschikbaar"}
                    {previousStatisticsSnapshotDate
                      ? ` (vergelijking: ${previousStatisticsSnapshotDate})`
                      : ""}
                  </div>
                </div>
              ) : null}
              </div>
            </div>
          </div>

          {manualTriggerMessage ? (
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700">
              {manualTriggerMessage}
            </div>
          ) : null}

          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:flex-wrap">
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

              <div>
                <label htmlFor="pickup-snapshot-date" className="block text-sm font-semibold text-gray-700">
                  Snapshot Date
                </label>
                <select
                  id="pickup-snapshot-date"
                  value={selectedSnapshotDate}
                  onChange={(event) => setSelectedSnapshotDate(event.target.value)}
                  className="mt-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                >
                  {availableSnapshotDates.length === 0 ? (
                    <option value="">Geen snapshot beschikbaar</option>
                  ) : (
                    availableSnapshotDates.map((snapshotDate) => (
                      <option key={snapshotDate} value={snapshotDate}>
                        {snapshotDate}
                      </option>
                    ))
                  )}
                </select>
              </div>

              <div>
                <label htmlFor="pickup-vs" className="block text-sm font-semibold text-gray-700">
                  Pickup vs.
                </label>
                <input
                  id="pickup-vs"
                  type="number"
                  min="1"
                  step="1"
                  value={pickupComparisonDaysInput}
                  onChange={(event) => setPickupComparisonDaysInput(event.target.value)}
                  className="mt-1 w-28 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                />
              </div>

              <div className="relative" ref={marketCodesRef}>
                <label className="block text-sm font-semibold text-gray-700">Market Codes</label>
                <button
                  type="button"
                  onClick={() => setMarketCodeDropdownOpen((currentValue) => !currentValue)}
                  className="mt-1 inline-flex min-w-[220px] items-center justify-between gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 shadow-sm"
                >
                  <span className="truncate">{marketCodeButtonLabel}</span>
                  <ChevronDown size={16} className="text-gray-500" />
                </button>

                {marketCodeDropdownOpen ? (
                  <div className="absolute left-0 top-full z-10 mt-2 w-72 rounded-lg border border-gray-200 bg-white p-3 shadow-lg">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-sm font-semibold text-gray-700">Selecteer market codes</span>
                      <button
                        type="button"
                        onClick={clearMarketCodeFilter}
                        className="text-xs font-medium text-blue-600 hover:text-blue-700"
                      >
                        Reset
                      </button>
                    </div>
                    <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                      {availableMarketCodes.length === 0 ? (
                        <div className="text-sm text-gray-500">Geen market codes beschikbaar.</div>
                      ) : (
                        availableMarketCodes.map((marketCode) => (
                          <label key={marketCode} className="flex items-center gap-2 text-sm text-gray-700">
                            <input
                              type="checkbox"
                              checked={selectedMarketCodes.includes(marketCode)}
                              onChange={() => toggleMarketCode(marketCode)}
                              className="h-4 w-4 rounded border-gray-300 text-blue-600"
                            />
                            <span>{marketCode}</span>
                          </label>
                        ))
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 w-full lg:w-auto">
              <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm">
                <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Total Rooms Sold
                </div>
                <div className="mt-1 text-lg font-semibold text-gray-900">
                  {totals.totalRoomsSold.toLocaleString()}
                </div>
                <div className={`mt-1 text-sm font-medium ${getDeltaTextClass(totalRoomsSoldPickup)}`}>
                  Pick-up vs day -{pickupComparisonDays}: {renderSignedValue(totalRoomsSoldPickup)}
                </div>
              </div>
              <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm">
                <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Total Calculated Revenue
                </div>
                <div className="mt-1 text-lg font-semibold text-gray-900">
                  {formatCurrency(totals.totalCalculatedRevenue)}
                </div>
                <div
                  className={`mt-1 text-sm font-medium ${getDeltaTextClass(totalCalculatedRevenuePickup)}`}
                >
                  Pick-up vs day -{pickupComparisonDays}: {renderSignedValue(
                    totalCalculatedRevenuePickup,
                    formatCurrency
                  )}
                </div>
              </div>
            </div>
          </div>

          {hotelRooms <= 0 ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
              Occupancy wordt pas correct weergegeven zodra <strong>Hotel Rooms</strong> is ingevuld op
              de General Settings pagina.
            </div>
          ) : null}

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
