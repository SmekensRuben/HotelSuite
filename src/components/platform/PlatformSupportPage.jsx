import React, { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getPlatformSupport, endPlatformSupport, platformError } from "../../services/firebasePlatform";
import { usePlatformQuery, usePlatformScope } from "../../hooks/usePlatformQuery";
import { Title, QueryState, Status, Moment, button, panel } from "./PlatformShared";

export default function PlatformSupportPage() {
  const { hotelUid, sessionId } = useParams(), navigate = useNavigate();
  const query = usePlatformQuery(() => getPlatformSupport(hotelUid, sessionId), `${hotelUid}:${sessionId}`);
  const capture = usePlatformScope(`${hotelUid}:${sessionId}`);
  const [now, setNow] = useState(Date.now()), [message, setMessage] = useState(null), [busy, setBusy] = useState(false);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 10000); return () => clearInterval(timer); }, []);
  useEffect(() => { const timer = setInterval(query.refresh, 60000); return () => clearInterval(timer); }, [query.refresh]);
  const end = async () => { const current = capture(); setBusy(true); try { await endPlatformSupport(sessionId); if (current()) navigate(`/platform/hotels/${hotelUid}`); } catch (error) { if (current()) { setMessage(platformError(error)); setBusy(false); } } };
  const expired = query.data && query.data.session.expiresAtMillis <= now;
  return <><Title title="Read-only hotel support" actions={<button disabled={busy} className={button} onClick={end}>End support session</button>}>Diagnostic access is scoped to this hotel and your current platform identity. Guest records, source files and credentials are excluded.</Title>{message && <p role="alert" className={`${panel} mb-5`}>{message}</p>}
    {expired ? <section className={panel}><h2 className="font-semibold">Support session expired</h2><Link className={`${button} mt-4 inline-block`} to={`/platform/hotels/${hotelUid}`}>Return to hotel management</Link></section> : <QueryState query={query}>{query.data && <div className="space-y-6"><section className="rounded-xl border border-sky-200 bg-sky-50 p-5"><h2 className="font-semibold">{query.data.hotel.name} · Read only</h2><p className="mt-2 text-sm">Reason: {query.data.session.reason}</p><p className="mt-2 text-sm">Expires: <Moment value={query.data.session.expiresAtMillis} /></p></section><section className={panel}><h2 className="font-semibold">Import health</h2><div className="mt-4 space-y-3">{query.data.monitoring.monitors.map((monitor) => <div key={monitor.id} className="flex justify-between gap-4"><span>{monitor.policy?.label || monitor.label}</span><Status value={monitor.health.status} /></div>)}</div>{!query.data.monitoring.monitors.length && <p className="mt-3 text-sm">No import monitoring is available.</p>}</section>
      <section className={panel}><h2 className="font-semibold">Delivery diagnostics</h2><p className="mt-2 text-sm text-slate-600">Unconfirmed delivery requires reconciliation with the provider before recovery.</p><div className="mt-4 grid gap-5 sm:grid-cols-2">{[["Mail queue", query.data.mail], ["Scheduled deliveries", query.data.scheduledDeliveries]].map(([label, data]) => <div key={label}><h3 className="font-medium">{label}</h3><p className="mt-1 text-xs text-slate-500">{data.inspected} records inspected{data.truncated && " · More records exist"}</p><ul className="mt-3 space-y-2 text-sm">{Object.entries(data.statuses).map(([status, count]) => <li key={status} className="flex justify-between"><Status value={status} /><span>{count}</span></li>)}</ul></div>)}</div></section><button className={button} onClick={query.refresh}>Refresh diagnostics</button></div>}</QueryState>}</>;
}
