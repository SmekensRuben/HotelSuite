import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import PendingStockCommand from "../inventory/PendingStockCommand";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import { Combobox } from "../ui/combobox";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { createStockCount, getStockCountSources, STOCK_COUNT_TYPES } from "../../services/firebaseStockCounts";
import { useScopedAsync } from "../../hooks/useScopedAsync";

const initialValues = {
  name: "",
  type: "Ad Hoc",
};

export default function StockCountCreatePage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const activeScope = useRef({ key: hotelUid });
  if (activeScope.current.key !== hotelUid) activeScope.current = { key: hotelUid };
  const [businessDate, setBusinessDate] = useState("");
  const [formValues, setFormValues] = useState(initialValues);
  const [locationRows, setLocationRows] = useState([]);
  const [saving, setSaving] = useState(false);
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

  const selectedRows = useMemo(
    () => locationRows.filter((row) => row.selected),
    [locationRows]
  );

  const hasSelectedLocationWithoutTemplate = selectedRows.some(
    (row) => row.templates.length === 0 || !row.stockTemplateId
  );

  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  const loadSources = useCallback(() => getStockCountSources(hotelUid), [hotelUid]);
  const { data: sources, loading, error: sourceError, retry } = useScopedAsync({
    scopeKey: hotelUid, enabled: Boolean(hotelUid), load: loadSources,
  });
  useEffect(() => {
    setLocationRows((sources || []).map((location) => ({ ...location, selected: true,
      stockTemplateId: location.templates[0]?.id || "" })));
  }, [sources]);

  useEffect(() => {
    activeScope.current = { key: hotelUid };
    setSaving(false); setError(""); setBusinessDate("");
    return () => { activeScope.current = { key: null }; };
  }, [hotelUid]);

  const handleFieldChange = (field) => (event) => {
    setFormValues((prev) => ({ ...prev, [field]: event.target.value }));
  };

  const toggleLocation = (locationId) => {
    setLocationRows((prev) =>
      prev.map((row) =>
        row.locationId === locationId ? { ...row, selected: !row.selected } : row
      )
    );
  };

  const handleTemplateChange = (locationId, stockTemplateId) => {
    setLocationRows((prev) =>
      prev.map((row) =>
        row.locationId === locationId ? { ...row, stockTemplateId } : row
      )
    );
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");

    if (!hotelUid || !formValues.name.trim()) return;
    if (!selectedRows.length) {
      setError("Select at least one location.");
      return;
    }
    if (selectedRows.length > 50) {
      setError("Select at most 50 locations per stock count.");
      return;
    }
    if (hasSelectedLocationWithoutTemplate) {
      setError("Every selected location needs a stock count template.");
      return;
    }

    const requestedScope = activeScope.current;
    setSaving(true);
    try {
      const locations = selectedRows.map((row) => ({ locationId: row.locationId, stockTemplateId: row.stockTemplateId }));

      await createStockCount(hotelUid, {
        ...formValues,
        ...(businessDate ? { businessDate } : {}),
        locations,
      });
      if (activeScope.current === requestedScope) navigate("/catalog/stock-counts");
    } catch (submitError) {
      if (activeScope.current === requestedScope) setError(submitError?.message || "Unable to create stock count.");
    } finally {
      if (activeScope.current === requestedScope) setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-canvas text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <ProcurementPage width="form" className="space-y-6">
        <div>
          <p className="text-sm text-gray-500 uppercase tracking-wide">Catalog</p>
          <h1 className="text-3xl font-semibold">Create Stock Count</h1>
          <p className="text-gray-600 mt-1">
            Select physical locations and templates. New counts use catalog base units; legacy supplier template links are validated and deduplicated.
          </p>
        </div>

        <PendingStockCommand kind="count" hotelUid={hotelUid} disabled={saving} onComplete={() => navigate("/catalog/stock-counts")} />
        {sourceError && <div role="alert"><p>{sourceError.message || "Unable to load stock sources."}</p><button type="button" onClick={retry}>Retry</button></div>}
        <Card>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="grid gap-4 md:grid-cols-2">
              <label className="text-sm font-medium">Business date (optional)<input aria-label="Business date" type="date" value={businessDate} onChange={(event) => setBusinessDate(event.target.value)} className="mt-1 block w-full rounded border px-3 py-2" /><span className="block text-xs text-gray-500">Blank uses today in the hotel time zone. Posting checkpoints determine receipt comparisons.</span></label>
              <div>
                <label htmlFor="stock-count-name" className="block text-sm font-medium text-gray-700 mb-1">
                  Name
                </label>
                <input
                  id="stock-count-name"
                  type="text"
                  value={formValues.name}
                  onChange={handleFieldChange("name")}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  required
                />
              </div>

              <div>
                <label htmlFor="stock-count-type" className="block text-sm font-medium text-gray-700 mb-1">
                  Type
                </label>
                <select
                  id="stock-count-type"
                  value={formValues.type}
                  onChange={handleFieldChange("type")}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                >
                  {STOCK_COUNT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-3 rounded-xl bg-slate-50 p-4 sm:p-5">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Locations</h2>
                <p className="text-sm text-gray-600">
                  All locations are selected by default. Change the template where needed.
                </p>
              </div>

              {loading ? (
                <p className="text-gray-600">Loading locations...</p>
              ) : locationRows.length === 0 ? (
                <p className="rounded-lg border border-dashed border-gray-300 px-4 py-6 text-sm text-gray-500">
                  No locations found.
                </p>
              ) : (
                <div className="rounded-xl border border-gray-200">
                  <div className="divide-y divide-gray-100 bg-white">
                    {locationRows.map((row) => (
                      <div key={row.locationId} className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(220px,320px)] md:items-center">
                        <label className="inline-flex items-center gap-3 text-sm font-medium text-gray-800">
                          <input
                            type="checkbox"
                            checked={row.selected}
                            onChange={() => toggleLocation(row.locationId)}
                            className="h-4 w-4 rounded border-gray-300 text-brand-800 focus:ring-brand-800"
                          />
                          <span>{row.locationName}</span>
                        </label>

                        <Combobox aria-label={`Template for ${row.locationName}`} options={row.templates} value={row.templates.find((template) => template.id === row.stockTemplateId) || null} onChange={(template) => handleTemplateChange(row.locationId, template?.id || "")} displayValue={(template) => template.name} getOptionValue={(template) => template.id} disabled={!row.selected || row.templates.length === 0 || saving} placeholder={row.templates.length ? "Select a template" : "No templates available"} className="ht-field" />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {error && <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => navigate("/catalog/stock-counts")}
                className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving || loading || Boolean(sourceError) || selectedRows.length === 0 || selectedRows.length > 50 || hasSelectedLocationWithoutTemplate}
                className="px-4 py-2 rounded-lg bg-brand-800 text-white text-sm font-semibold hover:bg-brand-950 disabled:opacity-60"
              >
                {saving ? "Saving..." : "Save Stock Count"}
              </button>
            </div>
          </form>
        </Card>
      </ProcurementPage>
    </div>
  );
}
