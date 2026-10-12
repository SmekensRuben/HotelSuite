import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { auth } from "../../firebaseConfig";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { getStockCountPackageOptions } from "../../services/firebaseStockCounts";
import { countPackageQuantity } from "../../utils/countPackageQuantity";
import { Combobox } from "../ui/combobox";

const description = (option) => `${option.supplierProductName} · ${option.supplierName} · ${option.purchaseUnit} (${option.catalogUnitsPerPackage} ${option.baseUnit})`;
export default function StockCountPackageEntry({ hotelUid, stockCountId, locationId, item, disabled = false, onApply }) {
  const [open, setOpen] = useState(false), [entries, setEntries] = useState([{ option: null, quantity: "" }]), [loose, setLoose] = useState("");
  const [olderOptions, setOlderOptions] = useState([]), [cursor, setCursor] = useState(null), [moreLoading, setMoreLoading] = useState(false), [moreError, setMoreError] = useState("");
  const generation = useRef(0), seen = useRef(new Set());
  const scopeKey = JSON.stringify([auth.currentUser?.uid, hotelUid, stockCountId, locationId, item.catalogProductId, item.baseUnit]);
  const load = useCallback(() => getStockCountPackageOptions(hotelUid, stockCountId, locationId, item.catalogProductId, { baseUnit: item.baseUnit }),
    [hotelUid, stockCountId, locationId, item.catalogProductId, item.baseUnit]);
  const packages = useScopedAsync({ scopeKey, enabled: open && !disabled, load });
  useEffect(() => {
    generation.current++; seen.current = new Set([packages.data?.nextCursor].filter(Boolean));
    setOlderOptions([]); setCursor(packages.data?.nextCursor || null); setMoreLoading(false); setMoreError("");
  }, [scopeKey, packages.data]);
  useEffect(() => { setEntries([{ option: null, quantity: "" }]); setLoose(""); }, [scopeKey, packages.data]);
  useEffect(() => { if (disabled || !open) generation.current++; }, [disabled, open]);
  useEffect(() => () => { generation.current++; }, []);
  const options = useMemo(() => [...new Map([...(packages.data?.options || []), ...olderOptions].map((option) => [option.id, option])).values()], [packages.data, olderOptions]);
  const calculation = useMemo(() => {
    try { return { ...countPackageQuantity(entries, loose, item.baseUnit), error: null }; }
    catch (error) { return { counted: false, text: "", error: error.message }; }
  }, [entries, loose, item.baseUnit]);
  const setEntry = (index, patch) => setEntries((current) => current.map((entry, position) => position === index ? { ...entry, ...patch } : entry));
  const loadMore = async () => {
    if (!cursor || moreLoading || disabled) return;
    const version = ++generation.current; setMoreLoading(true); setMoreError("");
    try {
      if (seen.current.size >= 10) throw new Error("More than 250 linked supplier products require a narrower configuration before loading all package choices.");
      const page = await getStockCountPackageOptions(hotelUid, stockCountId, locationId, item.catalogProductId, { baseUnit: item.baseUnit, afterSupplierProductId: cursor });
      if (version !== generation.current) return;
      if (page.nextCursor && seen.current.has(page.nextCursor)) throw new Error("Package pagination did not advance. Reload the choices.");
      if (page.nextCursor) seen.current.add(page.nextCursor);
      setOlderOptions((current) => [...current, ...page.options]); setCursor(page.nextCursor);
      if (page.unavailable.length) setMoreError("Some linked packages on this page need configuration review and are unavailable for package entry.");
    } catch (error) { if (version === generation.current) setMoreError(error.message || "Unable to load package choices."); }
    finally { if (version === generation.current) setMoreLoading(false); }
  };
  return <div className="min-w-0 border-t border-slate-100 pt-3 sm:col-span-2 lg:col-span-4">
    <button type="button" className="ht-button-secondary min-h-[44px]" disabled={disabled} aria-expanded={open}
      onClick={() => setOpen((value) => !value)}>{open ? "Hide package entry" : "Count packages and loose contents"}</button>
    {open && <div className="mt-3 space-y-3 rounded-xl bg-slate-50 p-3 sm:p-4">
      <p className="text-sm text-slate-600">Enter full packages and opened or loose contents. Apply replaces this article's count with the exact total in its frozen catalog unit; its optional estimated cost stays unchanged. Use Apply total before Save Counts; unapplied package entries are not saved.</p>
      {packages.loading && <p role="status" className="text-sm">Loading validated package choices…</p>}
      {packages.error && <div role="alert" className="text-sm text-red-700"><p>{packages.error.message}</p><p>Direct catalog-unit counting remains available.</p><button type="button" className="ht-button-secondary mt-2" onClick={packages.retry}>Retry package choices</button></div>}
      {packages.data && !packages.error && <>
        {!options.length && <p className="text-sm text-amber-800">No active, reviewed compatible packages are available. Enter the physical quantity directly in {item.baseUnit}.</p>}
        {packages.data.unavailable.length > 0 && <p className="text-sm text-amber-800">Some linked packages need configuration review and are unavailable for package entry. Unknown contents or incompatible units are never guessed.</p>}
        {entries.map((entry, index) => <div key={index} className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,120px)_auto] sm:items-end">
          <label className="min-w-0 text-sm font-medium">Validated package {index + 1}<Combobox aria-label={`Validated package ${index + 1}`} options={options} value={entry.option}
            onChange={(option) => setEntry(index, { option })} displayValue={description} getOptionValue={(option) => option.id} disabled={disabled || !options.length} placeholder="Search supplier package" /></label>
          <label className="text-sm font-medium">Full packages<input aria-label={`Full packages ${index + 1}`} type="number" inputMode="numeric" min="0" max="1000000" step="1" value={entry.quantity} disabled={disabled || !options.length}
            onChange={(event) => setEntry(index, { quantity: event.target.value })} className="ht-field mt-1 min-h-[44px] w-full" /></label>
          {entries.length > 1 && <button type="button" aria-label={`Remove package entry ${index + 1}`} disabled={disabled} className="ht-button-secondary min-h-[44px]" onClick={() => setEntries((current) => current.filter((_entry, position) => position !== index))}>Remove</button>}
        </div>)}
        <div className="flex flex-wrap gap-2">{options.length > 0 && entries.length < 10 && <button type="button" className="ht-button-secondary min-h-[44px]" disabled={disabled} onClick={() => setEntries((current) => [...current, { option: null, quantity: "" }])}>Add another package type</button>}
          {cursor && <button type="button" className="ht-button-secondary min-h-[44px]" disabled={disabled || moreLoading} onClick={loadMore}>{moreLoading ? "Loading more packages…" : "Load more package choices"}</button>}</div>
        {moreError && <p role="alert" className="text-sm text-amber-800">{moreError}</p>}
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
          <label className="text-sm font-medium">Loose quantity ({item.baseUnit})<input aria-label={`Loose quantity (${item.baseUnit})`} type="number" inputMode="decimal" min="0" max="1000000" step="0.000001" value={loose} disabled={disabled} placeholder="Uncounted"
            onChange={(event) => setLoose(event.target.value)} className="ht-field mt-1 min-h-[44px] w-full" /></label>
          <div><p className="text-sm text-slate-600">Calculated catalog count</p><p className="font-semibold" aria-live="polite">{calculation.counted ? `${calculation.text} ${item.baseUnit}` : "Uncounted"}</p></div>
          <button type="button" className="ht-button-primary min-h-[44px]" disabled={disabled || !calculation.counted || Boolean(calculation.error)} onClick={() => { onApply(calculation.text); setOpen(false); }}>Apply total to count</button>
        </div>
        {calculation.error && <p role="alert" className="text-sm text-red-700">{calculation.error}</p>}
      </>}
    </div>}
  </div>;
}
