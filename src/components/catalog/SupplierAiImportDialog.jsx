import React, { useCallback, useEffect, useRef, useState } from "react";
import { auth } from "../../firebaseConfig";
import { useNavigate } from "react-router-dom";
import { usePermission } from "../../hooks/usePermission";
import { getSuppliers } from "../../services/firebaseSuppliers";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { useSupplierProductAuthority } from "../../hooks/useSupplierProductAuthority";
import { currencyChoices } from "../../utils/propertySettingChoices";
import { Combobox } from "../ui/combobox";
import Modal from "../shared/Modal";
import {
  SUPPLIER_AI_IMPORT_ACCEPT, validateSupplierAiImportFile, getSupplierAiImportAvailability,
  startSupplierAiImport, getSupplierAiImport, normalizeSupplierAiImportSettings, supplierAiImportVatFraction,
} from "../../services/firebaseSupplierAiImports";

const currencyOptions = currencyChoices();
const supportedCurrency = (value) => currencyOptions.some((option) => option.id === value);
const processing = new Set(["queued", "processing"]);
const statuses = {
  queued: "Your document is queued.", processing: "Reading the document and preparing a review…",
  review: "Review the proposed products before importing.", failed: "Document processing failed. No products were changed.",
  response_unknown: "The import result could not be confirmed. Contact your hotel administrator before starting another import.",
  partially_committed: "Some rows have been processed. Review the remaining rows.", completed: "Import processing is complete.", expired: "This private draft is no longer available. Start a new document when you are ready.",
};
export default function SupplierAiImportDialog(props) {
  const authority = useSupplierProductAuthority();
  return <ScopedSupplierAiImportDialog key={authority} {...props} />;
}
function ScopedSupplierAiImportDialog({ open, onClose, hotelUid, suppliers = [], suppliersLoading = false, initialSupplierId = "", onOpenReview, trackedJobId = null, trackedJob = null, backgroundManaged = false, onJobChange, onNewDocument }) {
  const navigate = useNavigate();
  const actor = useRef(auth.currentUser).current, alive = useRef(true);
  const current = useCallback(() => alive.current && auth.currentUser === actor, [actor]);
  const canRead = usePermission("supplierproducts", "read"), canCreate = usePermission("supplierproducts", "create"), canReadSuppliers = usePermission("suppliers", "read");
  const permitted = canRead && canCreate && canReadSuppliers;
  const storageKey = `supplier-ai-import:${hotelUid}:${actor?.uid || "anonymous"}`;
  const [availability, setAvailability] = useState(null), [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [priceBasis, setPriceBasis] = useState(""), [currency, setCurrency] = useState(""), [sharedVat, setSharedVat] = useState(false), [vatPercent, setVatPercent] = useState("");
  const currencyTouched = useRef(false), pendingUploadSettings = useRef(null);
  const [supplierId, setSupplierId] = useState(initialSupplierId), [file, setFile] = useState(null), [job, setJob] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(null), [pollError, setPollError] = useState(null);
  const [uncertainUpload, setUncertainUpload] = useState(false);
  const input = useRef(null), generation = useRef(0), jobRequests = useRef(0), latestJob = useRef(job); latestJob.current = job;
  const [resuming, setResuming] = useState(false), [closeIn, setCloseIn] = useState(null);
  const closeDeadline = useRef(null);
  const previousTrackedJobId = useRef(trackedJobId);
  const jobChange = useRef(onJobChange); jobChange.current = onJobChange;
  const publishJob = (value) => { const accepted = jobChange.current?.(value); setJob(accepted || value); };
  const close = () => { setCloseIn(null); onClose?.(); };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!currencyTouched.current && supportedCurrency(availability?.defaults?.currency)) setCurrency(availability.defaults.currency); }, [availability?.defaults?.currency]);
  const clearPriceSettings = () => { setPriceBasis(""); setSharedVat(false); setVatPercent(""); currencyTouched.current = false; setCurrency(supportedCurrency(availability?.defaults?.currency) ? availability.defaults.currency : ""); pendingUploadSettings.current = null; };
  const restorePriceSettings = (value) => { setPriceBasis(value.priceBasis); setCurrency(value.currency); currencyTouched.current = true; setSharedVat(value.vatRate !== null); setVatPercent(value.vatRate === null ? "" : String(Number((value.vatRate * 100).toFixed(4)))); pendingUploadSettings.current = value; };
  const sharedVatRequired = priceBasis === "gross" && sharedVat;
  let enteredVatRate = null;
  try { if (sharedVatRequired) enteredVatRate = supplierAiImportVatFraction(vatPercent); } catch { /* Invalid VAT remains unavailable before any request. */ }
  const vatInputValid = !sharedVatRequired || enteredVatRate !== null;
  const priceSettingsReady = ["net", "gross", "unknown"].includes(priceBasis) && supportedCurrency(currency) && vatInputValid;
  useEffect(() => {
    if (!backgroundManaged || !current() || busy || uncertainUpload) return;
    if (!trackedJobId) {
      if (previousTrackedJobId.current && latestJob.current) {
        generation.current += 1; jobRequests.current += 1;
        setJob(null); setError(null); setPollError(null); setCloseIn(null);
        setFile(null); setSupplierId(initialSupplierId); clearPriceSettings(); setResuming(false);
      }
      previousTrackedJobId.current = null; return;
    }
    previousTrackedJobId.current = trackedJobId;
    if (latestJob.current?.jobId !== trackedJobId) {
      generation.current += 1; jobRequests.current += 1;
      setError(null); setPollError(null); setCloseIn(null);
      setUncertainUpload(false); setFile(null);
    }
    if (trackedJob) { setJob(trackedJob); setSupplierId(trackedJob.supplierId || ""); setResuming(false); return; }
    const captured = generation.current; setResuming(true);
    getSupplierAiImport(hotelUid, trackedJobId).then((value) => { if (current() && captured === generation.current) { publishJob(value); setSupplierId(value.supplierId || ""); } }).catch((failure) => { if (current() && captured === generation.current) setError(failure); }).finally(() => { if (current() && captured === generation.current) setResuming(false); });
  }, [backgroundManaged, trackedJobId, trackedJob, hotelUid, current, busy, uncertainUpload, initialSupplierId]);
  useEffect(() => {
    if (closeIn === null) return;
    if (!open || !job || !processing.has(job.status) || !current()) { setCloseIn(null); return; }
    const timer = setTimeout(() => {
      if (!current()) return;
      const remaining = Math.ceil((closeDeadline.current - Date.now()) / 1000);
      if (remaining <= 0) { setCloseIn(null); onClose?.(); } else setCloseIn(remaining);
    }, Math.min(1000, Math.max(0, closeDeadline.current - Date.now())));
    return () => clearTimeout(timer);
  }, [closeIn, open, job?.jobId, job?.status, current, onClose]);
  const remember = useCallback((value) => { try { sessionStorage.setItem(storageKey, JSON.stringify({ jobId: value.jobId })); } catch { /* Recovery remains available in the open view. */ } }, [storageKey]);
  const forget = () => { try { sessionStorage.removeItem(storageKey); } catch { /* Browser storage is optional. */ } };
  const loadAvailability = useCallback(async () => {
    if (!permitted || !hotelUid || !current()) return;
    setAvailabilityLoading(true); setError(null);
    try { const value = await getSupplierAiImportAvailability(hotelUid); if (current()) setAvailability(value.importPolicyVersion === 2 && value.reviewWorkspaceVersion === 1 ? value : { ...value, available: false, reason: value.available ? "upgrade-required" : value.reason }); }
    catch (failure) { if (current()) setError(failure); }
    finally { if (current()) setAvailabilityLoading(false); }
  }, [permitted, hotelUid, current]);
  useEffect(() => {
    if (!open || !permitted) return;
    loadAvailability();
    let jobId; try { jobId = JSON.parse(sessionStorage.getItem(storageKey) || "null")?.jobId; } catch { /* Invalid local reference is ignored. */ }
    if (backgroundManaged || !jobId || job) return;
    const captured = generation.current; setResuming(true);
    getSupplierAiImport(hotelUid, jobId).then((value) => { if (current() && captured === generation.current) { generation.current += 1; publishJob(value); setSupplierId(value.supplierId); setResuming(false); } }).catch((failure) => { if (current() && captured === generation.current) { setError(failure); try { sessionStorage.removeItem(storageKey); } catch { /* Optional browser storage. */ } } }).finally(() => { if (current() && (captured === generation.current || latestJob.current?.jobId === jobId)) setResuming(false); });
  }, [open, permitted, loadAvailability, hotelUid, storageKey, current, backgroundManaged]); // Job is resumed only when this view opens.
  const refreshJob = useCallback(async () => {
    if (!job?.jobId || !current()) return;
    const captured = { jobId: job.jobId, generation: generation.current, request: ++jobRequests.current };
    const active = () => current() && generation.current === captured.generation && latestJob.current?.jobId === captured.jobId && jobRequests.current === captured.request;
    try { const value = await getSupplierAiImport(hotelUid, captured.jobId); if (active()) { publishJob(value); setPollError(null); } }
    catch (failure) { if (active()) {
      setPollError(failure);
      if (["not-found", "failed-precondition"].includes(String(failure.code || "").replace(/^functions\//, ""))) {
        setPollError(null);
        const expired = { hotelUid, jobId: captured.jobId, ownerUid: actor?.uid, status: "expired", error: { message: failure.message } }; publishJob(expired);
        try { sessionStorage.removeItem(storageKey); } catch { /* An expired reference contains no source content. */ }
      }
    } }
  }, [job?.jobId, hotelUid, current, storageKey]);
  useEffect(() => {
    if (backgroundManaged || !job || !processing.has(job.status) || !current()) return;
    const timer = setTimeout(refreshJob, pollError ? 10000 : 3000);
    return () => clearTimeout(timer);
  }, [job, refreshJob, pollError, current, backgroundManaged]);
  const chooseFile = (event) => {
    const chosen = event.target.files?.[0];
    if (busy || uncertainUpload || !current()) return;
    setError(null);
    try { validateSupplierAiImportFile(chosen); setFile(chosen); }
    catch (failure) { event.target.value = ""; setFile(null); setError(failure); }
  };
  const start = async () => {
    if (!priceSettingsReady || !file || !supplierId || !supplierOptions.some((supplier) => supplier.id === supplierId) || directoryLoading || supplierDirectory.error || busy || resuming || !permitted || !availability?.available || !current()) return;
    const captured = ++generation.current;
    const importSettings = pendingUploadSettings.current || normalizeSupplierAiImportSettings({ policyVersion: 2, priceBasis, currency, vatRate: enteredVatRate });
    pendingUploadSettings.current = importSettings;
    setBusy(true); setError(null);
    try {
      const value = await startSupplierAiImport(hotelUid, supplierId, file, importSettings);
      if (!current() || captured !== generation.current) return;
      publishJob(value); remember(value); setUncertainUpload(false); pendingUploadSettings.current = null; setFile(null); if (processing.has(value.status)) { closeDeadline.current = Date.now() + 5000; setCloseIn(5); }
    } catch (failure) {
      if (!current() || captured !== generation.current) return;
      if (failure.code === "import-settings-changed" && failure.importSettings) { try { restorePriceSettings(normalizeSupplierAiImportSettings(failure.importSettings)); } catch { /* Invalid saved settings remain unavailable. */ } }
      setError(failure);
      setUncertainUpload(!["invalid-argument", "permission-denied", "unauthenticated", "failed-precondition", "resource-exhausted", "already-exists", "not-found"].includes(String(failure.code || "").replace(/^functions\//, "")));
    } finally { if (current() && captured === generation.current) setBusy(false); }
  };
  const openReview = () => {
    if (!current() || !job?.jobId) return;
    close();
    if (onOpenReview) onOpenReview(job.jobId);
    else navigate(`/catalog/supplier-products/imports/${encodeURIComponent(job.jobId)}`);
  };
  const reset = () => {
    if (busy || uncertainUpload) return;
    generation.current += 1; jobRequests.current += 1;
    setResuming(false); setPollError(null); forget(); clearPriceSettings(); setCloseIn(null); setJob(null); onNewDocument?.(); setFile(null); setError(null);
  };
  const loadSupplierDirectory = useCallback(() => getSuppliers(hotelUid), [hotelUid]);
  const supplierDirectory = useScopedAsync({ scopeKey: `${hotelUid}:ai-import-suppliers`, enabled: Boolean(backgroundManaged && open && !job && permitted), initialData: null, load: loadSupplierDirectory });
  const supplierOptions = backgroundManaged ? supplierDirectory.data || [] : suppliers;
  const directoryLoading = backgroundManaged ? supplierDirectory.loading : suppliersLoading;
  const limits = availability?.limits || {};
  return <Modal open={open} onClose={close} title="AI supplier-product import">
    <div className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
      <p className="text-sm text-stone-600">Convert a supplier document into a draft. Nothing is saved as a product until you review and confirm selected rows.</p>
      {!permitted && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Supplier-product read and create permissions, supplier read access and an active Procurement subscription are required.</p>}
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error.message}</p>}
      {!job && permitted && <>
        {resuming && <p role="status" className="animate-pulse text-sm text-stone-600">Recovering the saved private draft…</p>}
        {availabilityLoading && <p role="status" className="animate-pulse text-sm text-stone-600">Checking hotel import access…</p>}
        {!availabilityLoading && !availability && <button type="button" className="ht-button-secondary" onClick={loadAvailability}>Retry access check</button>}
        {availability && !availability.available && <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{availability.reason === "upgrade-required" ? "Import service update is in progress. Try again after it finishes." : "AI supplier imports are disabled. Ask the platform operator to enable the global AI import settings."}<button type="button" onClick={loadAvailability} className="ml-2 underline">Retry access check</button></p>}
        {availability?.available && <>
          <label className="block text-sm font-semibold">Supplier<Combobox aria-label="AI import supplier" disabled={busy || resuming || uncertainUpload} value={supplierOptions.find((supplier) => supplier.id === supplierId) || null} options={supplierOptions} displayValue={(supplier) => supplier.name || "Unnamed supplier"} getOptionValue={(supplier) => supplier.id} onChange={(supplier) => setSupplierId(supplier?.id || "")} loading={directoryLoading} placeholder="Choose this document's supplier" /></label>
          {backgroundManaged && supplierDirectory.error && <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900"><p role="alert">The supplier directory could not be loaded. {supplierDirectory.error.message}</p><button type="button" onClick={supplierDirectory.run} className="mt-2 underline">Retry supplier directory</button></div>}
          <fieldset disabled={busy || resuming || uncertainUpload} className="space-y-3 rounded-xl border border-stone-200 bg-stone-50 p-3">
            <legend className="px-1 text-sm font-semibold">Document price settings</legend>
            <p className="text-xs text-stone-600">Select how prices in this document are quoted. AI cannot turn sales totals or statistics into purchase prices.</p>
            <label className="block text-sm font-semibold">Document price basis<select aria-label="Document price basis" required value={priceBasis} onChange={(event) => { setPriceBasis(event.target.value); pendingUploadSettings.current = null; }} className="mt-1 w-full rounded-lg border bg-white p-2 text-sm"><option value="">Select how prices are quoted</option><option value="net">Net — excluding VAT</option><option value="gross">Gross — including VAT</option><option value="unknown">Unknown — requires review</option></select></label>
            <label className="block text-sm font-semibold">Document currency<Combobox aria-label="Document currency" disabled={busy || resuming || uncertainUpload} value={currencyOptions.find((option) => option.id === currency) || null} options={currencyOptions} displayValue={(option) => option.label} getOptionValue={(option) => option.id} onChange={(option) => { currencyTouched.current = true; setCurrency(option?.id || ""); pendingUploadSettings.current = null; }} placeholder="Choose this document's currency" allowClear /></label>
            {priceBasis === "gross" && <div className="space-y-2 text-sm"><label className="flex items-start gap-2"><input type="checkbox" checked={sharedVat} onChange={(event) => { setSharedVat(event.target.checked); pendingUploadSettings.current = null; }} className="mt-1" /><span>Use one shared VAT rate when a product has no documented rate</span></label>{sharedVat && <label className="block text-xs font-semibold">Shared VAT rate (%)<input type="number" required min="0" max="100" step="any" value={vatPercent} onChange={(event) => { setVatPercent(event.target.value); pendingUploadSettings.current = null; }} className="mt-1 w-full rounded-lg border bg-white p-2 text-sm" /></label>}<p className="text-xs text-stone-600">A documented product VAT rate takes precedence. No tax rate is guessed from the hotel's country. Gross prices without a VAT rate remain unavailable until reviewed.</p>{!vatInputValid && <p role="alert" className="text-xs text-red-700">Enter a shared VAT percentage from 0 to 100 with at most four decimal places, or leave shared VAT disabled.</p>}</div>}
            {priceBasis === "unknown" && <p className="text-xs text-amber-800">Prices without a documented net or gross basis require correction before they can be imported.</p>}
          </fieldset>
          <label className="block text-sm font-semibold">Supplier document<input ref={input} type="file" accept={SUPPLIER_AI_IMPORT_ACCEPT} disabled={busy || resuming || uncertainUpload} onChange={chooseFile} className="mt-2 block max-w-full text-sm" /></label>
          {file && <p className="text-xs text-stone-600">Selected: {file.name} · {(file.size / 1024).toFixed(1)} KiB</p>}
          <p className="text-xs text-stone-500">CSV, XLSX, PDF, DOCX, EML or TXT. Maximum {Math.floor((limits.maxFileBytes || 10485760) / 1048576)} MiB, {limits.maxPages || 50} document pages and {limits.maxProducts || 1000} products. Do not upload guest or personal data. Documents are private and expire automatically.</p>
          {uncertainUpload && <p className="text-sm text-amber-800">The upload acknowledgement was lost. Retry this same file and supplier to recover the original import; a new run will not be started.</p>}
          <button type="button" disabled={!priceSettingsReady || !file || !supplierId || !supplierOptions.some((supplier) => supplier.id === supplierId) || busy || resuming || directoryLoading || Boolean(supplierDirectory.error)} onClick={start} className="ht-button-primary w-full">{busy ? "Uploading document…" : uncertainUpload ? "Recover original upload" : "Prepare AI import review"}</button>
        </>}
      </>}
      {job && <>
        <div role="status" className={`rounded-xl border p-3 text-sm ${["failed", "response_unknown", "expired"].includes(job.status) ? "border-red-200 bg-red-50 text-red-900" : "border-brand-200 bg-brand-50"}`}><p className="font-semibold">{statuses[job.status] || `Import status: ${job.status}`}</p><p className="mt-1 text-xs">{job.source?.fileName || "Supplier document"}</p>{processing.has(job.status) && <div aria-hidden="true" className="mt-3 h-1.5 overflow-hidden rounded-full bg-brand-100"><div className="h-full w-1/2 animate-pulse rounded-full bg-brand-700" /></div>}</div>
        {processing.has(job.status) && job.progress?.totalChunks > 0 && <p className="text-xs text-stone-600">{job.progress.completedChunks} of {job.progress.totalChunks} document sections processed.</p>}
        {closeIn !== null && processing.has(job.status) && <div className="flex items-center justify-between gap-3 rounded-lg bg-stone-50 p-3 text-sm"><p role="status">This dialog closes in {closeIn} {closeIn === 1 ? "second" : "seconds"}. The import continues in the background.</p><button type="button" onClick={() => setCloseIn(null)} className="shrink-0 text-brand-800 underline">Keep open</button></div>}
        {job.importSettings ? <section aria-label="Applied document price settings" className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs text-stone-600"><p className="font-semibold">Applied document price settings</p><p className="mt-1">{job.importSettings.priceBasis === "net" ? "Net — excluding VAT" : job.importSettings.priceBasis === "gross" ? "Gross — including VAT" : "Unknown price basis — requires review"} · {job.importSettings.currency} · {job.importSettings.vatRate === null ? "No shared VAT rate supplied" : `${(job.importSettings.vatRate * 100).toLocaleString(undefined, { maximumFractionDigits: 4 })}% shared VAT where the source has no rate`}</p><p className="mt-1">These settings are saved with this import. Documented product-specific values take precedence.</p></section> : <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">This earlier import has no saved document price settings. Existing rows have not been recalculated, and new selections are not applied to this draft.</p>}
        {job.expiresAtMillis && <p className="text-xs text-stone-500">Private draft expires {new Date(job.expiresAtMillis).toLocaleString()}. Your import keeps running when you close this dialog or visit another page.</p>}
        {Array.isArray(job.warnings) && job.warnings.map((warning, index) => <p key={index} className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900">{typeof warning === "string" ? warning : warning.message || warning.code || "Document extraction needs review."}</p>)}
        {job.error && <p role="alert" className="text-sm text-red-800">{job.error.message || String(job.error)}</p>}
        {pollError && <p role="alert" className="text-sm text-amber-800">{pollError.message} The original import reference is retained.</p>}
        <button type="button" onClick={refreshJob} disabled={busy} className="ht-button-secondary">Refresh import status</button>
        <div className="rounded-xl border border-stone-200 bg-white p-4">
          <h2 className="font-semibold">Review on the import page</h2>
          <p className="mt-1 text-sm text-stone-600">Follow processing, review products one at a time and confirm the approved selection on a separate page. Products are never saved automatically.</p>
          <button type="button" onClick={openReview} disabled={busy} className="ht-button-primary mt-3">Open import review</button>
        </div>
        {!processing.has(job.status) && <button type="button" disabled={busy || uncertainUpload} onClick={reset} className="ht-button-secondary">Start another document</button>}
      </>}
    </div>
  </Modal>;
}
