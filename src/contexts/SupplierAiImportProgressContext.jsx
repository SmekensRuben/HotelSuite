import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { toast } from "react-toastify";
import { auth } from "../firebaseConfig";
import { useHotelContext } from "./HotelContext";
import { useSupplierProductAuthority } from "../hooks/useSupplierProductAuthority";
import { featureIsLicensed } from "../constants/moduleCatalog";
import { hasPermission } from "../utils/permissions";
import { getSupplierAiImport } from "../services/firebaseSupplierAiImports";
import { supplierAiImportSummary, supplierAiImportSettings, supplierAiImportCategoryCounts } from "../utils/supplierAiImportSummary";
import SupplierAiImportProgress from "../components/catalog/SupplierAiImportProgress";
import SupplierAiImportDialog from "../components/catalog/SupplierAiImportDialog";

const ProgressContext = createContext(null);
const ACTIVE = new Set(["uploading", "queued", "processing"]);
const SUCCESS = new Set(["review", "partially_committed", "completed"]);
const FAILURE = new Set(["failed", "response_unknown", "expired"]);
const STATUSES = new Set([...ACTIVE, ...SUCCESS, ...FAILURE]);
const MAX_REFERENCES = 8;
const validId = (value) => typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value && !/[\\/\u0000-\u001f]/.test(value) && ![".", ".."].includes(value);
const safeText = (value, maximum = 500) => typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").slice(0, maximum) : undefined;
const privateDetail = /\b(?:budget|bill(?:ed|ing)?|costs?|pricing|USD|tokens?|gpt[-\s]?[\w.-]+|openai|reasoning|fallback|model)\b|(?:US\$|\$)\s*\d/i;
const safeMessage = (value) => privateDetail.test(String(value || "")) ? "This import needs administrator assistance before it can continue." : safeText(value);

// Customer progress deliberately keeps no provider, pricing, token or budget data.
export function supplierAiProgressMetadata(value, hotelUid, ownerUid) {
  if (!value || value.hotelUid !== hotelUid || value.ownerUid !== ownerUid || !validId(value.jobId) || !STATUSES.has(value.status)) return null;
  return {
    hotelUid, ownerUid, jobId: value.jobId, status: value.status,
    ...(validId(value.supplierId) ? { supplierId: value.supplierId } : {}),
    ...(value.source?.fileName ? { source: { fileName: safeText(value.source.fileName, 180) } } : {}),
    ...(Number.isSafeInteger(value.expiresAtMillis) && value.expiresAtMillis > 0 ? { expiresAtMillis: value.expiresAtMillis } : {}),
    ...(Number.isSafeInteger(value.totalRows) && value.totalRows >= 0 && value.totalRows <= 1000 ? { totalRows: value.totalRows } : {}),
    counts: supplierAiImportCategoryCounts(value.counts, value.totalRows),
    importSettings: supplierAiImportSettings(value.importSettings),
    summary: supplierAiImportSummary(value.summary, { totalRows: value.totalRows, counts: value.counts }),
    progress: {
      completedChunks: Number.isSafeInteger(value.progress?.completedChunks) && value.progress.completedChunks >= 0 && value.progress.completedChunks <= 32 ? value.progress.completedChunks : null,
      totalChunks: Number.isSafeInteger(value.progress?.totalChunks) && value.progress.totalChunks > 0 && value.progress.totalChunks <= 32 ? value.progress.totalChunks : null,
    },
    ...(value.error?.message ? { error: { message: safeMessage(value.error.message) } } : {}),
    ...(Array.isArray(value.warnings) ? { warnings: value.warnings.slice(0, 25).map((warning) => safeMessage(typeof warning === "string" ? warning : warning?.message)).filter(Boolean) } : {}),
  };
}

function readReferences(storageKey, legacyKey) {
  try {
    const stored = sessionStorage.getItem(storageKey), oldStored = sessionStorage.getItem(legacyKey);
    const saved = JSON.parse(stored && stored.length <= 12288 ? stored : "null");
    const legacy = JSON.parse(oldStored && oldStored.length <= 256 ? oldStored : "null");
    const values = Array.isArray(saved?.jobIds) ? saved.jobIds : [];
    if (validId(legacy?.jobId)) values.push(legacy.jobId);
    const jobIds = [...new Set(values.filter(validId))].slice(-MAX_REFERENCES);
    return { jobIds, activeIds: Array.isArray(saved?.activeIds) ? [...new Set(saved.activeIds.filter((value) => jobIds.includes(value)))].slice(-MAX_REFERENCES) : [],
      notified: Array.isArray(saved?.notified) ? saved.notified.filter((item) => validId(item?.jobId) && jobIds.includes(item.jobId) && ["ready", ...FAILURE].includes(item.status)).slice(-MAX_REFERENCES * 2) : [] };
  } catch { return { jobIds: [], activeIds: [], notified: [] }; }
}

export function useSupplierAiImportProgress() { return useContext(ProgressContext); }

export function SupplierAiImportProgressProvider({ children }) {
  const hotel = useHotelContext();
  const authority = useSupplierProductAuthority();
  const actor = auth.currentUser;
  const permitted = Boolean(actor?.uid && actor.emailVerified !== false && hotel.hotelUid
    && !hotel.authLoading && !hotel.permissionsLoading && !hotel.subscriptionLoading
    && (!hotel.currentUser || hotel.currentUser === actor) && hotel.subscriptionActive === true
    && featureIsLicensed(hotel.subscription, "supplierproducts")
    && hasPermission({ permissions: hotel.permissions }, "supplierproducts", "read")
    && hasPermission({ permissions: hotel.permissions }, "supplierproducts", "create")
    && hasPermission({ permissions: hotel.permissions }, "suppliers", "read"));
  const scopeKey = JSON.stringify([authority, permitted, hotel.authLoading, hotel.permissionsLoading, hotel.subscriptionLoading]);
  return <ScopedSupplierAiImportProgressProvider key={scopeKey} hotelUid={hotel.hotelUid} actor={actor} permitted={permitted}>{children}</ScopedSupplierAiImportProgressProvider>;
}

function ScopedSupplierAiImportProgressProvider({ children, hotelUid, actor, permitted }) {
  const storageKey = `supplier-ai-progress:${actor?.uid || "anonymous"}:${hotelUid || "none"}`;
  const legacyKey = `supplier-ai-import:${hotelUid}:${actor?.uid || "anonymous"}`;
  const recovery = useRef(permitted ? readReferences(storageKey, legacyKey) : { jobIds: [], activeIds: [], notified: [] }).current;
  const [jobs, setJobs] = useState(recovery.jobIds.map((jobId) => ({ hotelUid, ownerUid: actor.uid, jobId, status: "recovering" })));
  const jobsRef = useRef(jobs); jobsRef.current = jobs;
  const [dialog, setDialog] = useState(null);
  const [newOptions, setNewOptions] = useState({});
  const alive = useRef(true), controls = useRef(new Map());
  const observedActive = useRef(new Set(recovery.activeIds));
  const notified = useRef(new Set(recovery.notified.map((item) => JSON.stringify([item.jobId, item.status]))));
  const notificationIds = useRef(new Map());
  const denied = useRef(false);
  const current = useCallback(() => alive.current && !denied.current && permitted && auth.currentUser === actor, [permitted, actor]);
  const persist = useCallback((next) => {
    try {
      if (next.length) {
        const jobIds = next.map((job) => job.jobId);
        const terminalMarkers = [...notified.current].map((key) => JSON.parse(key)).filter(([jobId]) => jobIds.includes(jobId)).slice(-MAX_REFERENCES * 2).map(([jobId, status]) => ({ jobId, status }));
        sessionStorage.setItem(storageKey, JSON.stringify({ jobIds, activeIds: jobIds.filter((jobId) => observedActive.current.has(jobId)), notified: terminalMarkers }));
      }
      else sessionStorage.removeItem(storageKey);
      sessionStorage.removeItem(legacyKey);
    } catch { /* Progress remains available without browser storage. */ }
  }, [storageKey, legacyKey]);
  const replaceJobs = useCallback((next) => {
    const retained = new Set(next.map((job) => job.jobId));
    for (const [jobId, control] of controls.current) {
      if (!retained.has(jobId) || !next.some((job) => job.jobId === jobId && (ACTIVE.has(job.status) || job.status === "recovering"))) {
        clearTimeout(control.timer); controls.current.delete(jobId);
      }
    }
    observedActive.current = new Set([...observedActive.current].filter((jobId) => retained.has(jobId)));
    notified.current = new Set([...notified.current].filter((fingerprint) => retained.has(JSON.parse(fingerprint)[0])));
    for (const [toastId, jobId] of notificationIds.current) if (!retained.has(jobId)) { toast.dismiss(toastId); notificationIds.current.delete(toastId); }
    jobsRef.current = next; setJobs(next); persist(next);
  }, [persist]);
  const clearJobs = useCallback(() => {
    for (const control of controls.current.values()) clearTimeout(control.timer);
    controls.current.clear(); replaceJobs([]); setDialog(null);
  }, [replaceJobs]);
  const notify = useCallback((prior, value) => {
    if (!prior || !(ACTIVE.has(prior.status) || prior.status === "recovering" && observedActive.current.has(prior.jobId)) || !(SUCCESS.has(value.status) || FAILURE.has(value.status)) || !current()) return;
    const fingerprint = JSON.stringify([value.jobId, SUCCESS.has(value.status) ? "ready" : value.status]);
    if (notified.current.has(fingerprint)) return;
    notified.current.add(fingerprint);
    const toastId = `supplier-ai:${actor.uid}:${hotelUid}:${fingerprint}`;
    notificationIds.current.set(toastId, value.jobId);
    const message = value.status === "review" || value.status === "partially_committed"
      ? "Your supplier import draft is ready for review. No products have been saved automatically."
      : value.status === "completed" ? "Your reviewed supplier import is complete."
      : value.status === "response_unknown" ? "Your supplier import needs attention. Open its status for details."
      : value.status === "expired" ? "Your supplier import draft has expired."
      : "Your supplier document could not be processed. Open its status for details.";
    const show = FAILURE.has(value.status) ? toast.error : toast.success;
    show(message, { toastId, onClick: () => { if (current()) setDialog({ jobId: value.jobId, open: true }); } });
  }, [current, actor, hotelUid]);
  const watchJob = useCallback((incoming, options = {}) => {
    if (!current()) return;
    const value = supplierAiProgressMetadata(incoming, hotelUid, actor.uid);
    if (!value) return;
    const prior = jobsRef.current.find((job) => job.jobId === value.jobId);
    // A delayed background response must never restore an older processing state.
    if (prior && (SUCCESS.has(prior.status) || FAILURE.has(prior.status)) && ACTIVE.has(value.status)) return prior;
    if (prior?.status === "expired" && value.status !== "expired") return prior;
    if (prior && FAILURE.has(prior.status) && SUCCESS.has(value.status)) return prior;
    if (prior?.status === "completed" && ["review", "partially_committed"].includes(value.status)) return prior;
    if (prior?.status === "partially_committed" && value.status === "review") return prior;
    if (prior && ACTIVE.has(prior.status) && ACTIVE.has(value.status) && Number.isSafeInteger(prior.progress?.completedChunks) && Number.isSafeInteger(value.progress?.completedChunks) && value.progress.completedChunks < prior.progress.completedChunks) return prior;
    if (prior && ACTIVE.has(prior.status) && ACTIVE.has(value.status) && ["uploading", "queued", "processing"].indexOf(value.status) < ["uploading", "queued", "processing"].indexOf(prior.status)) return prior;
    if (ACTIVE.has(value.status)) observedActive.current.add(value.jobId);
    const next = jobsRef.current.filter((job) => job.jobId !== value.jobId);
    next.push(value);
    const active = next.filter((job) => ACTIVE.has(job.status) || job.status === "recovering");
    const settled = next.filter((job) => !ACTIVE.has(job.status) && job.status !== "recovering");
    notify(prior, value);
    replaceJobs([...settled.slice(-Math.max(0, MAX_REFERENCES - active.length)), ...active].slice(-MAX_REFERENCES));
    if (options.fromDialog === true) setDialog((priorDialog) => priorDialog?.jobId === null ? { ...priorDialog, jobId: value.jobId } : priorDialog);
    return value;
  }, [current, hotelUid, actor, replaceJobs, notify]);
  const pollRef = useRef(null);
  const schedule = useCallback((jobId, delay) => {
    if (!current()) return;
    const control = controls.current.get(jobId) || { timer: null, inFlight: false, failures: 0 };
    controls.current.set(jobId, control);
    if (control.timer || control.inFlight) return;
    control.timer = setTimeout(() => { control.timer = null; pollRef.current?.(jobId); }, delay);
  }, [current]);
  pollRef.current = async (jobId) => {
    const prior = jobsRef.current.find((job) => job.jobId === jobId);
    if (!current() || !prior || !(ACTIVE.has(prior.status) || prior.status === "recovering")) return;
    const control = controls.current.get(jobId);
    if (!control || control.inFlight) return;
    control.inFlight = true;
    try {
      const result = await getSupplierAiImport(hotelUid, jobId);
      if (!current() || controls.current.get(jobId) !== control || !jobsRef.current.some((job) => job.jobId === jobId)) return;
      const value = supplierAiProgressMetadata(result, hotelUid, actor.uid);
      if (!value || value.jobId !== jobId) throw new Error("The import status could not be verified.");
      control.failures = 0;
      watchJob(value);
    } catch (error) {
      if (!current()) return;
      const code = String(error?.code || "").replace(/^functions\//, "");
      if (["permission-denied", "unauthenticated"].includes(code)) { denied.current = true; clearJobs(); return; }
      if (code === "not-found" || code === "failed-precondition" && /expir/i.test(error.message || "")) {
        watchJob({ hotelUid, ownerUid: actor.uid, jobId, status: "expired", error: { message: "This private draft is no longer available. Start a new document when you are ready." } });
      } else {
        control.failures += 1;
        replaceJobs(jobsRef.current.map((job) => job.jobId === jobId ? { ...job, connectionWarning: "Status updates are temporarily unavailable. Processing continues in the background." } : job));
      }
    } finally {
      control.inFlight = false;
      const latest = jobsRef.current.find((job) => job.jobId === jobId);
      if (current() && latest && (ACTIVE.has(latest.status) || latest.status === "recovering")) schedule(jobId, Math.min(30000, 3000 * 2 ** Math.min(control.failures, 4)));
    }
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const control of controls.current.values()) clearTimeout(control.timer);
      controls.current.clear();
      for (const toastId of notificationIds.current.keys()) toast.dismiss(toastId);
    };
  }, []);
  useEffect(() => {
    if (!current()) return;
    for (const job of jobs) {
      if (ACTIVE.has(job.status) || job.status === "recovering") schedule(job.jobId, job.status === "recovering" ? 0 : 3000);
      else { const control = controls.current.get(job.jobId); if (control) { clearTimeout(control.timer); control.timer = null; } }
    }
  }, [jobs, current, schedule]);
  const openNew = useCallback((options = {}) => { if (current()) { setNewOptions(options); setDialog({ jobId: null, open: true }); } }, [current]);
  const openJob = useCallback((jobId) => { if (current() && jobsRef.current.some((job) => job.jobId === jobId)) setDialog({ jobId, open: true }); }, [current]);
  const closeDialog = useCallback(() => setDialog((prior) => prior ? { ...prior, open: false } : null), []);
  const dismissJob = useCallback((jobId) => {
    if (!current()) return;
    const job = jobsRef.current.find((entry) => entry.jobId === jobId);
    if (!job || ACTIVE.has(job.status) || job.status === "recovering") return;
    replaceJobs(jobsRef.current.filter((entry) => entry.jobId !== jobId));
    setDialog((prior) => prior?.jobId === jobId ? null : prior);
  }, [current, replaceJobs]);
  const selected = dialog?.jobId ? jobs.find((job) => job.jobId === dialog.jobId) : null;
  const value = { jobs: permitted ? jobs : [], watchJob, updateJob: watchJob, openNew, openJob, closeDialog, dismissJob, dialog };
  return <ProgressContext.Provider value={value}>
    {children}
    {permitted && <SupplierAiImportProgress />}
    {permitted && dialog && <SupplierAiImportDialog {...newOptions} open={dialog.open} hotelUid={hotelUid} onClose={closeDialog} trackedJobId={dialog.jobId} trackedJob={selected?.status === "recovering" ? null : selected} backgroundManaged onJobChange={(incoming) => watchJob(incoming, { fromDialog: true })} onNewDocument={() => setDialog({ jobId: null, open: true })} />}
  </ProgressContext.Provider>;
}
