import React, { useState } from "react";
import { Link } from "react-router-dom";
import { listPlatformIncidents, acknowledgePlatformIncident, platformError } from "../../services/firebasePlatform";
import { usePlatformQuery } from "../../hooks/usePlatformQuery";
import { Title, QueryState, Moment, Status, button, field, panel } from "./PlatformShared";

function Incident({ incident, refresh }) {
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const acknowledge = async (event) => { event.preventDefault(); if (busy) return; setBusy(true); setError(null);
    try { await acknowledgePlatformIncident(incident.id, reason); await refresh(); }
    catch (failure) { setError(platformError(failure)); setBusy(false); }
  };
  return <article className={panel}><div className="flex flex-wrap justify-between gap-3"><div><Link className="font-semibold underline" to={`/platform/hotels/${incident.hotelUid}/imports`}>{incident.hotelUid}</Link><p className="mt-2 text-sm">{incident.code.replace(/-/g, " ")} · Expected data: {incident.expectedBusinessDate || "Unknown"}</p></div><Status value={incident.state} /></div><p className="mt-3 text-xs text-slate-500">Detected: <Moment value={incident.firstDetectedAtMillis} /> · Last check: <Moment value={incident.lastDetectedAtMillis} /></p>{incident.acknowledgedAtMillis && <p className="mt-3 text-sm">Acknowledged <Moment value={incident.acknowledgedAtMillis} />. {incident.state === "open" && "The underlying issue remains open."}</p>}
    {incident.state === "open" && !incident.acknowledgedAtMillis && <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={acknowledge}><label className="min-w-64 flex-1 text-sm">Review note<input className={field} required maxLength={300} disabled={busy} value={reason} onChange={(event) => setReason(event.target.value)} /></label><button disabled={busy} className={button}>Acknowledge incident</button>{error && <p role="alert" className="w-full">{error}</p>}</form>}
  </article>;
}
export default function PlatformIncidentsPage() {
  const [cursor, setCursor] = useState(null), [previous, setPrevious] = useState([]), [onlyOpen, setOnlyOpen] = useState(true);
  const query = usePlatformQuery(() => listPlatformIncidents(cursor), cursor);
  const rows = (query.data?.incidents || []).filter((row) => !onlyOpen || row.state === "open");
  return <><Title title="Notifications" actions={<button className={button} onClick={query.refresh}>Refresh</button>}>Missing or unhealthy expected imports create in-app incidents. Acknowledgment records your review and preserves the actual health result.</Title><label className="mb-5 block text-sm"><input type="checkbox" checked={onlyOpen} onChange={(event) => setOnlyOpen(event.target.checked)} /> Show open incidents on this page</label>
    <QueryState query={query}><div className="space-y-4">{rows.map((incident) => <Incident key={incident.id} incident={incident} refresh={query.refresh} />)}{!rows.length && <p className={panel}>No matching incidents on this page. Unconfigured monitoring does not generate delivery expectations.</p>}</div><div className="mt-5 flex justify-between"><button className={button} disabled={!previous.length} onClick={() => { setCursor(previous.at(-1)); setPrevious(previous.slice(0, -1)); }}>Previous page</button><button className={button} disabled={!query.data?.nextCursor} onClick={() => { setPrevious([...previous, cursor]); setCursor(query.data.nextCursor); }}>Next page</button></div></QueryState></>;
}
