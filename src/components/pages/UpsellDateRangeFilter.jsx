import React, { useState } from "react";

export const DATE_RANGE_PRESETS = {
  thisMonth: "This Month",
  thisWeek: "This Week",
  thisYear: "This Year",
  custom: "Custom",
};

export function toDateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getDateRangeForPreset(preset) {
  const today = new Date();
  const startDate = new Date(today);

  if (preset === "thisWeek") {
    const mondayOffset = (today.getDay() + 6) % 7;
    startDate.setDate(today.getDate() - mondayOffset);
  } else if (preset === "thisYear") {
    startDate.setMonth(0, 1);
  } else {
    startDate.setDate(1);
  }

  const endDate = new Date(today);
  if (preset === "thisMonth") {
    endDate.setMonth(today.getMonth() + 1, 0);
  } else if (preset === "thisYear") {
    endDate.setMonth(11, 31);
  }

  return {
    startDate: toDateInputValue(startDate),
    endDate: toDateInputValue(endDate),
  };
}

export default function UpsellDateRangeFilter({ dateRange, preset, onPresetChange, onDateRangeChange, compact = false }) {
  const [customRangeOpen, setCustomRangeOpen] = useState(false);

  const handlePresetChange = (event) => {
    const nextPreset = event.target.value;
    onPresetChange(nextPreset);
    setCustomRangeOpen(nextPreset === "custom");

    if (nextPreset !== "custom") {
      onDateRangeChange(getDateRangeForPreset(nextPreset));
    }
  };

  const handleCustomDateChange = (field) => (event) => {
    onDateRangeChange({ ...dateRange, [field]: event.target.value });
  };

  return (
    <div className={compact ? "" : "rounded-xl border border-gray-200 bg-white p-4 shadow-sm"}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="text-sm font-medium text-gray-700">
          {!compact && "Period"}
          <select
            value={preset}
            onChange={handlePresetChange}
            className={compact ? "block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 sm:w-40" : "mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 sm:w-48"}
          >
            {Object.entries(DATE_RANGE_PRESETS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        {preset === "custom" && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setCustomRangeOpen((open) => !open)}
              className="inline-flex w-full items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 sm:w-auto"
            >
              {dateRange.startDate || "Start date"} – {dateRange.endDate || "End date"}
            </button>

            {customRangeOpen && (
              <div className="mt-3 grid gap-4 rounded-lg border border-gray-200 bg-white p-4 shadow-lg sm:absolute sm:z-10 sm:w-96 sm:grid-cols-2">
                <label className="text-sm font-medium text-gray-700">
                  Start date
                  <input
                    type="date"
                    value={dateRange.startDate}
                    onChange={handleCustomDateChange("startDate")}
                    className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </label>
                <label className="text-sm font-medium text-gray-700">
                  End date
                  <input
                    type="date"
                    value={dateRange.endDate}
                    onChange={handleCustomDateChange("endDate")}
                    className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </label>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
