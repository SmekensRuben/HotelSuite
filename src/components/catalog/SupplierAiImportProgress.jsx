import React, { useEffect, useState } from "react";
import { CheckCircle2, ChevronDown, CircleAlert, LoaderCircle, X } from "lucide-react";
import { useMatch } from "react-router-dom";
import { useSupplierAiImportProgress } from "../../contexts/SupplierAiImportProgressContext";

const active = new Set(["uploading", "queued", "processing", "recovering"]);
const failed = new Set(["failed", "response_unknown", "expired"]);
const label = (job) => active.has(job.status) ? job.status === "recovering" ? "Recovering status" : "In progress"
  : failed.has(job.status) ? job.status === "expired" ? "Draft expired" : "Needs attention"
  : job.status === "completed" ? "Import complete" : "Ready for review";

export default function SupplierAiImportProgress() {
  const progress = useSupplierAiImportProgress();
  const onReviewPage = useMatch("/catalog/supplier-products/imports/:jobId");
  const [expanded, setExpanded] = useState(false);
  const jobs = progress?.jobs || [];
  useEffect(() => { if (!jobs.length) setExpanded(false); }, [jobs.length]);
  // The workspace shows its own status; keep background polling in the provider.
  if (!jobs.length || onReviewPage) return null;
  const working = jobs.filter((job) => active.has(job.status));
  const errors = jobs.filter((job) => failed.has(job.status));
  const Icon = working.length ? LoaderCircle : errors.length ? CircleAlert : CheckCircle2;
  const summary = working.length ? `${working.length} import${working.length === 1 ? "" : "s"} in progress`
    : errors.length ? `${errors.length} import${errors.length === 1 ? " needs" : "s need"} attention`
    : jobs.some((job) => job.status !== "completed") ? "Import ready for review" : "Import complete";
  const tone = working.length ? "border-brand-200 bg-brand-50 text-brand-900" : errors.length ? "border-red-200 bg-red-50 text-red-800" : "border-emerald-200 bg-emerald-50 text-emerald-900";
  return <aside aria-label="Supplier import progress" className="fixed right-3 top-20 z-40 w-[min(320px,calc(100vw-1.5rem))] sm:right-5">
    <button type="button" className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left text-sm shadow-panel ${tone} ${jobs.length === 1 && !active.has(jobs[0].status) ? "pr-10" : ""}`} aria-label={summary} aria-expanded={jobs.length > 1 ? expanded : undefined} onClick={() => jobs.length === 1 ? progress.openJob(jobs[0].jobId) : setExpanded((prior) => !prior)}>
      <Icon size={20} className={working.length ? "shrink-0 animate-spin motion-reduce:animate-none" : "shrink-0"} aria-hidden="true" />
      <span className="min-w-0 flex-1"><span className="block font-semibold">{summary}</span><span className="block text-xs opacity-80">{jobs.length === 1 && jobs[0].connectionWarning ? "Reconnecting to status updates…" : "Click to open import review"}</span></span>
      {jobs.length > 1 && <ChevronDown size={16} className={expanded ? "rotate-180" : ""} aria-hidden="true" />}
    </button>
    {jobs.length === 1 && !active.has(jobs[0].status) && <button type="button" className="ht-icon-button absolute right-1.5 top-1.5 h-7 w-7" onClick={() => progress.dismissJob(jobs[0].jobId)} aria-label={`Dismiss ${jobs[0].source?.fileName || "supplier document"} from progress`}><X size={14} aria-hidden="true" /></button>}
    {expanded && <div className="mt-2 max-h-[60dvh] space-y-2 overflow-y-auto rounded-xl border border-stone-200 bg-white p-2 shadow-lifted">
      {jobs.map((job) => {
        const JobIcon = active.has(job.status) ? LoaderCircle : failed.has(job.status) ? CircleAlert : CheckCircle2;
        return <div key={job.jobId} className="flex items-center gap-2 rounded-lg bg-stone-50 p-2">
          <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => { progress.openJob(job.jobId); setExpanded(false); }} aria-label={`Open ${job.source?.fileName || "supplier document"}: ${label(job)}`}>
            <JobIcon size={18} aria-hidden="true" className={`shrink-0 ${active.has(job.status) ? "animate-spin motion-reduce:animate-none text-brand-700" : failed.has(job.status) ? "text-red-700" : "text-emerald-700"}`} />
            <span className="min-w-0 text-xs"><span className="block truncate font-semibold">{job.source?.fileName || "Supplier document"}</span><span className="block">{label(job)}</span>{job.connectionWarning && <span className="mt-1 block text-amber-800">Reconnecting to status updates…</span>}</span>
          </button>
          {!active.has(job.status) && <button type="button" className="ht-icon-button h-7 w-7 shrink-0" onClick={() => progress.dismissJob(job.jobId)} aria-label={`Dismiss ${job.source?.fileName || "supplier document"} from progress`}><X size={14} aria-hidden="true" /></button>}
        </div>;
      })}
    </div>}
  </aside>;
}
