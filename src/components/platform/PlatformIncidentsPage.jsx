import React, { useState } from "react";
import { Link } from "react-router-dom";
import { listPlatformIncidents, acknowledgePlatformIncident, resolvePlatformWorkflowIncident, platformError } from "../../services/firebasePlatform";
import { usePlatformQuery } from "../../hooks/usePlatformQuery";
import { Title, QueryState, Moment, Status, button, field, panel } from "./PlatformShared";

const label = (value) => String(value || "unknown").replace(/-/g, " ");
const safeId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

function Evaluator({ monitoring }) {
  const status = monitoring?.status || "unknown";
  return <section className={`${panel} mb-5`} aria-label="Purchasing monitoring evaluator">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">Purchasing &amp; Inventory monitoring</h2><Status value={status} /></div>
    <p className="mt-3 text-sm">Environment: {monitoring?.environment || "Unknown"} · Last successful evaluation: <Moment value={monitoring?.lastSuccessfulAtMillis} /></p>
    <p className="mt-2 text-sm">Last attempt: <Moment value={monitoring?.lastAttemptAtMillis} />{Number.isSafeInteger(monitoring?.failedHotels) && ` · Hotels requiring evaluator review: ${monitoring.failedHotels}`}</p>
    {(!monitoring || ["unknown", "stale", "failed", "partial", "not-configured", "invalid-configuration"].includes(status)) && <p role="status" className="mt-3 text-sm text-amber-900">Current monitoring coverage is not verified. An empty incident list does not establish healthy operations. Review evaluator configuration and execution evidence.</p>}
    {(monitoring?.enabled === false || ["disabled", "paused"].includes(status)) && <p className="mt-3 text-sm">Scheduled purchasing monitoring is disabled or paused in this environment.</p>}
    {monitoring?.environment === "staging" && <p className="mt-3 text-sm">Staging simulations do not establish production delivery or production monitoring activation.</p>}
    <p className="mt-3 text-xs text-slate-500">Alerts are visible in this console. External notifications require separately configured channels and recipients.</p>
  </section>;
}

function Incident({ incident, refresh }) {
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const [reviewOutcome, setReviewOutcome] = useState("");
  const acknowledge = async (event) => { event.preventDefault(); if (busy) return; setBusy(true); setError(null);
    try { await acknowledgePlatformIncident(incident.id, reason); await refresh(); }
    catch (failure) { setError(platformError(failure)); }
    finally { setBusy(false); }
  };
  const closeReviewedAlert = async (event) => {
    event.preventDefault(); if (busy) return; setBusy(true); setError(null);
    try { await resolvePlatformWorkflowIncident(incident.id, incident.lastDetectedAtMillis, reviewOutcome); await refresh(); }
    catch (failure) { setError(platformError(failure)); }
    finally { setBusy(false); }
  };
  const hotelPath = safeId(incident.hotelUid) ? `/platform/hotels/${encodeURIComponent(incident.hotelUid)}` : null;
  const imports = !incident.process || incident.process === "imports";
  return <article className={`${panel} min-w-0 break-words`}>
    <div className="flex flex-wrap justify-between gap-3"><div className="min-w-0"><h2 className="font-semibold">{incident.summary || label(incident.code)}</h2><p className="mt-2 text-sm">{incident.environment || "Environment not recorded"} · Hotel {incident.hotelUid} · {label(incident.process || "imports")}</p></div><div className="flex flex-wrap items-start gap-2"><Status value={incident.severity || "warning"} /><Status value={incident.state} /></div></div>
    <dl className="mt-4 grid min-w-0 gap-x-5 gap-y-3 text-sm sm:grid-cols-2">
      <div><dt className="text-xs text-slate-500">First observation</dt><dd><Moment value={incident.firstDetectedAtMillis} /></dd></div>
      <div><dt className="text-xs text-slate-500">Last observation</dt><dd><Moment value={incident.lastDetectedAtMillis} /></dd></div>
      <div><dt className="text-xs text-slate-500">Source evidence</dt><dd><Moment value={incident.evidenceAtMillis} /></dd></div>
      <div><dt className="text-xs text-slate-500">Source / correlation</dt><dd className="break-all">{incident.sourceId || incident.monitorId || "Unknown"}{incident.correlationId ? ` · ${incident.correlationId}` : ""}</dd></div>
    </dl>
    {incident.expectedBusinessDate && <p className="mt-3 text-sm">Expected data: {incident.expectedBusinessDate}</p>}
    {incident.process === "workflow" && incident.metadata?.workflowProcess && <p className="mt-3 text-sm">Observed workflow: {label(incident.metadata.workflowProcess)} · {label(incident.metadata.origin)} · {label(incident.metadata.failureClass)}</p>}
    <p className="mt-4 text-sm"><span className="font-semibold">Safe next step: </span>{incident.nextStep || "Review the configured import expectation and retained source evidence before taking action."}</p>
    {hotelPath && <Link className="mt-3 inline-block text-sm font-semibold underline" to={`${hotelPath}${imports ? "/imports" : "#purchasing-monitoring"}`}>Review hotel {imports ? "import evidence" : "diagnostics"}</Link>}
    <p className="mt-2 text-xs text-slate-500">Diagnostic access does not grant operational hotel permissions. Provider acceptance does not establish inbox delivery or supplier acceptance.</p>
    {incident.resolvedAtMillis && <p className="mt-3 text-sm">{incident.resolutionMode === "operator-review" ? "Closed after operator review:" : "Recovered:"} <Moment value={incident.resolvedAtMillis} />{incident.episode ? ` · Episode ${incident.episode}` : ""}</p>}
    {incident.acknowledgedAtMillis && <p className="mt-3 text-sm">Acknowledged <Moment value={incident.acknowledgedAtMillis} />. {incident.state === "open" && "The underlying issue remains open."}</p>}
    {incident.state === "open" && !incident.acknowledgedAtMillis && <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={acknowledge}><label className="min-w-0 flex-1 basis-56 text-sm" htmlFor={`review-${incident.id}`}>Review note<input id={`review-${incident.id}`} className={field} required maxLength={300} disabled={busy} value={reason} onChange={(event) => setReason(event.target.value)} /></label><button disabled={busy} className={`${button} w-full sm:w-auto`}>Acknowledge incident</button>{error && <p role="alert" className="w-full">{error}</p>}</form>}
    {incident.process === "workflow" && incident.code === "unexpected-workflow-error" && <div className="mt-4 border-t border-slate-200 pt-4"><p className="text-sm">Operator review can close this workflow alert. Closing it does not establish that an order, email or inventory action succeeded.</p>{incident.state === "open" && <form className="mt-3 flex flex-wrap items-end gap-3" onSubmit={closeReviewedAlert}><label className="min-w-0 flex-1 basis-56 text-sm" htmlFor={`outcome-${incident.id}`}>Review outcome<input id={`outcome-${incident.id}`} className={field} required maxLength={300} disabled={busy} value={reviewOutcome} onChange={(event) => setReviewOutcome(event.target.value)} /></label><button className={`${button} w-full sm:w-auto`} disabled={busy}>Close reviewed workflow alert</button></form>}</div>}
    {error && incident.acknowledgedAtMillis && <p role="alert" className="mt-3">{error}</p>}
  </article>;
}
export default function PlatformIncidentsPage() {
  const [cursor, setCursor] = useState(null), [previous, setPrevious] = useState([]), [onlyOpen, setOnlyOpen] = useState(true);
  const [process, setProcess] = useState(""), [severity, setSeverity] = useState(""), [hotel, setHotel] = useState("");
  const query = usePlatformQuery(() => listPlatformIncidents(cursor), cursor);
  const allRows = query.data?.incidents || [];
  const rows = allRows.filter((row) => (!onlyOpen || row.state === "open") && (!process || (row.process || "imports") === process) && (!severity || (row.severity || "warning") === severity) && (!hotel || row.hotelUid?.toLowerCase().includes(hotel.trim().toLowerCase())));
  return <><Title title="Notifications" actions={<button className={button} onClick={query.refresh}>Refresh</button>}>Review failures, delayed work and uncertain outcomes across monitored processes. Acknowledgment records your review and preserves the actual health result.</Title>
    <QueryState query={query}><Evaluator monitoring={query.data?.monitoring} />
      <div className={`${panel} mb-5 grid gap-4 sm:grid-cols-3`}><label className="min-w-0 text-sm">Hotel on this page<input className={field} maxLength={128} value={hotel} onChange={(event) => setHotel(event.target.value)} /></label><label className="min-w-0 text-sm">Process on this page<select className={field} value={process} onChange={(event) => setProcess(event.target.value)}><option value="">All processes</option>{[...new Set(allRows.map((row) => row.process || "imports"))].sort().map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></label><label className="min-w-0 text-sm">Severity on this page<select className={field} value={severity} onChange={(event) => setSeverity(event.target.value)}><option value="">All severities</option><option value="critical">Critical</option><option value="warning">Warning</option><option value="info">Info</option></select></label><label className="text-sm sm:col-span-3"><input type="checkbox" checked={onlyOpen} onChange={(event) => setOnlyOpen(event.target.checked)} /> Show open incidents on this page</label></div>
      <div className="space-y-4">{rows.map((incident) => <Incident key={`${incident.id}:${incident.episode || 0}`} incident={incident} refresh={query.refresh} />)}{!rows.length && <p className={panel}>No matching incidents on this page. Missing or unconfigured monitoring does not establish healthy operations.</p>}</div>
      <div className="mt-5 flex flex-wrap justify-between gap-3"><button className={button} disabled={!previous.length} onClick={() => { setCursor(previous.at(-1)); setPrevious(previous.slice(0, -1)); }}>Previous page</button><button className={button} disabled={!query.data?.nextCursor} onClick={() => { setPrevious([...previous, cursor]); setCursor(query.data.nextCursor); }}>Next page</button></div>
    </QueryState></>;
}
