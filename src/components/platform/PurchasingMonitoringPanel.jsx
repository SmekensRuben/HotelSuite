import React from "react";
import { Link } from "react-router-dom";
import { getPlatformPurchasingMonitoring } from "../../services/firebasePlatform";
import { usePlatformQuery } from "../../hooks/usePlatformQuery";
import { QueryState, Moment, Status, button, panel } from "./PlatformShared";

export default function PurchasingMonitoringPanel({ hotelUid }) {
  const query = usePlatformQuery(() => getPlatformPurchasingMonitoring(hotelUid), hotelUid);
  const health = query.data?.health, monitoring = query.data?.monitoring;
  return <section id="purchasing-monitoring" className={`${panel} min-w-0`}>
    <div className="flex flex-wrap justify-between gap-3"><h2 className="text-lg font-semibold">Purchasing &amp; Inventory monitoring</h2><button className={button} onClick={query.refresh}>Refresh monitoring</button></div>
    <QueryState query={query}>
      <p className="mt-3 text-sm">Environment: {monitoring?.environment || "Unknown"} · Evaluator: <Status value={monitoring?.status || "unknown"} /></p>
      <p className="mt-3 text-sm">Last successful evaluator run: <Moment value={monitoring?.lastSuccessfulAtMillis} /></p>
      <p className="mt-2 text-sm">This hotel was last assessed: <Moment value={health?.computedAtMillis} /> · <Status value={health?.status || "unknown"} /></p>
      {!health && <p className="mt-3 text-sm text-amber-900">No verified monitoring assessment is available for this hotel.</p>}
      {["unknown", "stale", "failed", "partial", "invalid-configuration"].includes(monitoring?.status) && <p className="mt-3 text-sm text-amber-900">Current evaluator coverage is not verified. Retained hotel observations may be out of date.</p>}
      {monitoring?.enabled === false && <p className="mt-3 text-sm">Scheduled purchasing monitoring is disabled or unconfigured in this environment.</p>}
      <h3 className="mt-4 text-sm font-semibold">Source scan coverage</h3>
      <ul className="mt-3 space-y-3">{(health?.coverage || []).map((row) => <li key={row.process} className="flex min-w-0 flex-wrap items-center justify-between gap-3 text-sm"><span className="min-w-0 break-words">{row.process?.replace(/-/g, " ")} · {row.inspected ?? "Unknown"} records inspected{row.truncated && " · More records require evaluation"}</span><Status value={row.status === "healthy" ? "scan-complete" : row.status || "unknown"} /></li>)}</ul>
      <p className="mt-4 text-xs text-slate-500">Missing measurements remain unknown. Simulation and provider acceptance do not establish production delivery. Diagnostics grant no operational hotel permissions.</p>
      <Link className={`${button} mt-4 inline-block`} to="/platform/incidents">Review platform incidents</Link>
    </QueryState>
  </section>;
}
