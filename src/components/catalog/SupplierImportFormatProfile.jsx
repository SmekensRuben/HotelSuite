import React, { useEffect, useRef, useState } from "react";
import { saveSupplierPurchaseUnitMappings, applySupplierImportFormat, readSupplierPurchaseUnitMappings } from "../../services/firebaseSupplierImportWorkspace";

const columnFields = [
  ["supplierSku", "Article number"], ["supplierProductName", "Article name"], ["brand", "Brand"], ["purchaseUnit", "Purchase package"],
  ["baseUnitsPerPurchaseUnit", "Total package content"], ["baseUnit", "Physical base unit"],
  ["packCount", "Units in purchase package"], ["contentQuantity", "Content of one unit"], ["contentUnit", "Unit content measure"],
  ["pricePerPurchaseUnit", "Price per purchase package"], ["pricePerBaseUnit", "Price per content unit"],
  ["priceBasis", "Net or gross basis"], ["currency", "Currency"], ["vatRate", "VAT rate"],
  ["sourceIssuedOn", "Source issued date"], ["priceValidFrom", "Valid from"], ["priceValidUntil", "Valid until"], ["gtin", "Package barcode"],
];
const terminal = (error) => ["invalid-argument", "permission-denied", "unauthenticated", "not-found", "failed-precondition", "already-exists", "aborted"].includes(String(error?.code || "").replace(/^functions\//, ""));
const buildDraft = (value) => ({ version: 1, header: value.header, sheetName: value.sheetName || null, columns: { ...(value.columns || {}) }, defaults: Object.fromEntries(Object.entries(value.defaults || {}).filter(([field]) => ["baseUnit", "currency", "priceBasis", "pricingModel", "vatRate"].includes(field))), assortmentMode: value.assortmentMode || "unknown", documentPurpose: value.documentPurpose || "price-list", decimalSeparator: value.decimalSeparator || ".", dateFormat: value.dateFormat || "YYYY-MM-DD" });

/** A confirmed format is separate from approving the extracted products. */
export default function SupplierImportFormatProfile({ hotelUid, supplierId, sourceFormat, profileId, jobId, profile, candidate, interpretation, formatApplication = null, canCreate, canUpdate, locked, current, onSaved, onApplied, onBusyChange }) {
  const source = candidate || profile?.interpretation;
  const sourceKey = JSON.stringify([hotelUid, supplierId, sourceFormat, profileId, jobId, source?.header, source?.sheetName, profile?.revision]);
  const [draft, setDraft] = useState(source ? buildDraft(source) : null), [acknowledged, setAcknowledged] = useState(false);
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(null), [message, setMessage] = useState("");
  const mounted = useRef(true), pending = useRef(null), latest = useRef(sourceKey);
  latest.current = sourceKey;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setDraft(source ? buildDraft(source) : null); setAcknowledged(false); setEditing(false); setError(null); setMessage(""); pending.current = null; }, [sourceKey]);
  const active = (captured) => mounted.current && current() && latest.current === captured;
  if (!source?.header?.length || !draft || !profile) return null;
  const applicationPending = Boolean(formatApplication && !formatApplication.complete);
  const canSave = !applicationPending && canCreate && (!profile.interpretation || canUpdate);
  const disabled = locked || busy || Boolean(pending.current);
  const change = (field, value) => { if (disabled) return; setDraft((prior) => ({ ...prior, [field]: value })); setAcknowledged(false); };
  const changeColumn = (field, value) => { const columns = { ...draft.columns }; if (value === "") delete columns[field]; else columns[field] = Number(value); change("columns", columns); };
  const changeDefault = (field, value) => { const defaults = { ...draft.defaults }; if (value === "") delete defaults[field]; else defaults[field] = value; change("defaults", defaults); };
  const run = async (kind) => {
    if (!current() || locked || busy || (kind === "save" ? !canSave : !canCreate)) return;
    const command = pending.current || { kind, scope: sourceKey, revision: kind === "apply" && applicationPending ? formatApplication.profileRevision : profile.revision, ...(kind === "apply" && applicationPending ? { requestId: formatApplication.requestId } : {}), interpretation: draft };
    if (command.kind === "save" && (!acknowledged || !Number.isInteger(command.interpretation.columns.supplierSku))) return;
    pending.current = command; setBusy(true); onBusyChange?.(true); setError(null); setMessage("");
    try {
      if (command.kind === "save") {
        const saved = await saveSupplierPurchaseUnitMappings(hotelUid, supplierId, sourceFormat, profileId, command.revision, [], { interpretation: command.interpretation });
        if (!active(command.scope)) return;
        pending.current = null; onSaved?.(saved); setEditing(false); setAcknowledged(false);
        setMessage("Reviewed file format saved for future imports. This draft keeps its original interpretation until you explicitly reprocess it. No products or prices have been approved.");
      } else {
        await applySupplierImportFormat(hotelUid, jobId, { expectedMappingRevision: command.revision, ...(command.requestId ? { requestId: command.requestId } : {}) });
        if (!active(command.scope)) return;
        pending.current = null; await onApplied?.();
        if (active(command.scope)) setMessage("This draft was reprocessed with the confirmed file format. Review the updated proposals before approving any products.");
      }
    } catch (failure) {
      if (active(command.scope)) {
        setError(failure);
        if (terminal(failure)) {
          pending.current = null;
          if (String(failure.code || "").replace(/^functions\//, "") === "aborted") {
            try { const refreshed = await readSupplierPurchaseUnitMappings(hotelUid, supplierId, sourceFormat, profileId); if (active(command.scope)) onSaved?.(refreshed); }
            catch (readFailure) { if (active(command.scope)) setError(readFailure); }
          }
        }
      }
    } finally { if (mounted.current && current()) { setBusy(false); onBusyChange?.(false); } }
  };
  return <section aria-label="Reusable supplier file format" className="space-y-3 rounded-xl border border-stone-200 bg-stone-50 p-3 sm:p-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-semibold text-brand-950">Reusable file format</h3><p className="mt-1 text-xs text-stone-600">Confirm article numbers, package contents, price basis and date columns once. Future files with the same exact headers and sheet use this interpretation.</p></div><button type="button" className="ht-button-secondary text-xs" disabled={disabled || !canSave} onClick={() => setEditing((value) => !value)}>{editing ? "Close format editor" : "Review file format"}</button></div>
    <p className={`rounded-lg p-2 text-xs ${interpretation?.status === "confirmed" ? "bg-green-50 text-green-900" : "bg-amber-50 text-amber-950"}`}>{interpretation?.status === "confirmed" ? "This document uses a previously confirmed format." : interpretation?.status === "review-required" ? "The file format changed. Check every mapped column before reusing this supplier profile." : profile.interpretation ? "A confirmed supplier profile is available. Apply it explicitly to this draft after checking the file format." : "This file format has not been confirmed. Suggestions are starting points for your review."}</p>
    {interpretation?.status === "review-required" && profile.interpretation && <details className="text-xs text-stone-600"><summary className="cursor-pointer font-semibold">Previously confirmed interpretation</summary><p className="mt-2 break-words">{profile.interpretation.header.map((header, index) => `${index + 1}. ${header || "(empty header)"}`).join(" · ")}</p><dl className="mt-2 space-y-1">{columnFields.filter(([field]) => Number.isInteger(profile.interpretation.columns?.[field])).map(([field, label]) => <div key={field} className="flex flex-wrap gap-x-2"><dt className="font-medium">{label}:</dt><dd>{profile.interpretation.header[profile.interpretation.columns[field]] || "(empty header)"}</dd></div>)}</dl></details>}
    {editing && <fieldset disabled={disabled || !canSave} className="space-y-4">
      <div><p className="text-xs text-stone-600">Check a product below against its source evidence before confirming the format.</p><p className="mt-2 text-xs font-semibold">Exact source headers{draft.sheetName ? ` · Sheet: ${draft.sheetName}` : ""}</p><p className="mt-1 break-words text-xs text-stone-600">{draft.header.map((header, index) => `${index + 1}. ${header || "(empty header)"}`).join(" · ")}</p></div>
      <div className="grid gap-3 sm:grid-cols-2">{columnFields.map(([field, label]) => <label key={field} className="text-xs font-semibold">{label}<select aria-label={`Format column: ${label}`} value={draft.columns[field] ?? ""} onChange={(event) => changeColumn(field, event.target.value)} className="mt-1 w-full rounded-lg border bg-white p-2 text-sm"><option value="">Not supplied by this column</option>{draft.header.map((header, index) => <option key={index} value={index}>{index + 1}. {header || "(empty header)"}</option>)}</select></label>)}</div>
      <details><summary className="cursor-pointer text-xs font-semibold">Number, date and consistent document settings</summary><div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-semibold">Decimal separator<select aria-label="Format decimal separator" value={draft.decimalSeparator} onChange={(event) => change("decimalSeparator", event.target.value)} className="ht-field mt-1 w-full"><option value=".">Dot (12.50)</option><option value=",">Comma (12,50)</option></select></label>
        <label className="text-xs font-semibold">Date format<select aria-label="Format date format" value={draft.dateFormat} onChange={(event) => change("dateFormat", event.target.value)} className="ht-field mt-1 w-full"><option value="YYYY-MM-DD">YYYY-MM-DD</option><option value="DD/MM/YYYY">DD/MM/YYYY</option></select></label>
        <label className="text-xs font-semibold">Default content unit<select aria-label="Format default content unit" value={draft.defaults.baseUnit || ""} onChange={(event) => changeDefault("baseUnit", event.target.value)} className="ht-field mt-1 w-full"><option value="">Unknown</option>{["g", "kg", "ml", "l", "each"].map((unit) => <option key={unit}>{unit}</option>)}</select></label>
        <label className="text-xs font-semibold">Default price basis<select aria-label="Format default price basis" value={draft.defaults.priceBasis || ""} onChange={(event) => changeDefault("priceBasis", event.target.value)} className="ht-field mt-1 w-full"><option value="">Unknown</option><option value="net">Net — excluding VAT</option><option value="gross">Gross — including VAT</option></select></label>
        <label className="text-xs font-semibold">Default currency<input aria-label="Format default currency" value={draft.defaults.currency || ""} maxLength={3} onChange={(event) => changeDefault("currency", event.target.value.toUpperCase())} className="ht-field mt-1 w-full" placeholder="Unknown" /></label>
        <label className="text-xs font-semibold">Default VAT rate (%)<input aria-label="Format default VAT rate" type="number" min="0" max="100" step="any" value={typeof draft.defaults.vatRate === "number" ? Number((draft.defaults.vatRate * 100).toFixed(4)) : ""} onChange={(event) => changeDefault("vatRate", event.target.value === "" ? "" : Number((Number(event.target.value) / 100).toFixed(6)))} className="ht-field mt-1 w-full" placeholder="Unknown" /></label>
        <label className="text-xs font-semibold">Usual list scope<select aria-label="Format usual list scope" value={draft.assortmentMode} onChange={(event) => change("assortmentMode", event.target.value)} className="ht-field mt-1 w-full"><option value="unknown">Unknown</option><option value="partial">Partial update</option><option value="full">Full assortment</option></select></label>
        <label className="text-xs font-semibold">Usual document purpose<select aria-label="Format usual document purpose" value={draft.documentPurpose} onChange={(event) => change("documentPurpose", event.target.value)} className="ht-field mt-1 w-full"><option value="price-list">Unit prices</option><option value="product-list">Article details</option><option value="statistics">Purchase statistics</option></select></label>
      </div><p className="mt-2 text-xs text-stone-600">Unknown fields stay unknown. Per-document dates are never saved as fixed recurring defaults. Missing products remain unchanged.</p></details>
      <label className="flex items-start gap-2 text-xs text-stone-700"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-0.5" /><span>I checked the columns against this source, including its package contents and price units. Use this interpretation for future matching files.</span></label>
      <button type="button" className="ht-button-primary" disabled={disabled || !canSave || !acknowledged || !Number.isInteger(draft.columns.supplierSku)} onClick={() => run("save")}>Save reviewed file format</button>
    </fieldset>}
    {applicationPending && <p role="status" className="text-xs text-amber-950">Format application paused after {formatApplication.processed} of {formatApplication.totalRows} articles. Resume the original operation with profile revision {formatApplication.profileRevision}; review decisions stay paused until it completes.</p>}
    {jobId && (profile.interpretation || applicationPending) && <button type="button" className="ht-button-secondary text-xs" disabled={disabled || !canCreate} onClick={() => run("apply")}>{applicationPending ? "Resume original format application" : "Reprocess this draft with saved format"}</button>}
    {jobId && profile.interpretation && canCreate && !canUpdate && <p className="text-xs text-stone-500">Reprocessing a draft containing existing supplier offers also requires update permission. The service checks this before changing any draft rows.</p>}
    {!canSave && <p className="text-xs text-stone-500">Create permission is required to save a format. Replacing an existing format also requires update permission.</p>}
    {message && <p role="status" className="text-xs text-green-900">{message}</p>}
    {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800"><p>{error.message}</p>{pending.current && <button type="button" className="mt-2 underline" disabled={locked || busy} onClick={() => run(pending.current.kind)}>Retry the same format operation</button>}</div>}
  </section>;
}
