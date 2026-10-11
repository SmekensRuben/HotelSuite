import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { listPlatformHotels, getPlatformMonitoring, getPlatformHotel, savePlatformImportMonitor, refreshPlatformMonitoring, retryPlatformImport, platformError } from "../../services/firebasePlatform";
import { usePlatformQuery, usePlatformScope } from "../../hooks/usePlatformQuery";
import { Title, QueryState, Status, Moment, button, primary, field, panel } from "./PlatformShared";

function MonitorEditor({ monitor, timeZone, hotelUid, onSaved }) {
  const initial = monitor.policy || { label: monitor.label, timeZone: timeZone || "", expectedBy: "07:30", graceMinutes: 30,
    weekdays: [0, 1, 2, 3, 4, 5, 6], businessDateOffsetDays: 0, startsOn: new Intl.DateTimeFormat("sv-SE").format(new Date()), enabled: true, paused: false, acceptEmpty: false };
  const keys = ["label", "timeZone", "expectedBy", "graceMinutes", "weekdays", "businessDateOffsetDays", "startsOn", "enabled", "paused", "acceptEmpty"];
  const [policy, setPolicy] = useState(Object.fromEntries(keys.map((key) => [key, initial[key]]))), [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const capture = usePlatformScope(hotelUid);
  const change = (key, value) => setPolicy({ ...policy, [key]: value });
  const save = async (event) => {
    event.preventDefault(); if (busy) return; setBusy(true); setError(null);
    const current = capture();
    try { await savePlatformImportMonitor({ hotelUid, typeId: monitor.id, expectedRevision: monitor.policy?.revision || 0,
      policy: { ...policy, graceMinutes: Number(policy.graceMinutes), businessDateOffsetDays: Number(policy.businessDateOffsetDays) } }); if (current()) await onSaved(); }
    catch (failure) { if (current()) setError(platformError(failure)); }
    finally { if (current()) setBusy(false); }
  };
  return <details className="mt-3"><summary className="cursor-pointer text-sm font-medium underline">{monitor.policy ? "Edit expected delivery" : "Configure expected delivery"}</summary><form onSubmit={save} className="mt-4 space-y-4 rounded-xl border p-4">
    <div className="grid gap-4 sm:grid-cols-2">{[["label", "Label", "text"], ["timeZone", "IANA time zone", "text"], ["expectedBy", "Expected by (local time)", "time"], ["startsOn", "Monitor from", "date"]].map(([key, label, type]) => <label key={key} className="text-sm">{label}<input required disabled={busy} className={field} type={type} value={policy[key] || ""} onChange={(event) => change(key, event.target.value)} maxLength={key === "label" ? 120 : 80} /></label>)}
      <label className="text-sm">Grace period (minutes)<input required disabled={busy} className={field} type="number" min="0" max="720" value={policy.graceMinutes} onChange={(event) => change("graceMinutes", event.target.value)} /></label>
      <label className="text-sm">Data-date offset (days)<input required disabled={busy} className={field} type="number" min="-366" max="366" value={policy.businessDateOffsetDays} onChange={(event) => change("businessDateOffsetDays", event.target.value)} /><span className="mt-1 block text-xs text-slate-500">0 = delivery day's data; −1 = previous day's data.</span></label></div>
    <fieldset disabled={busy}><legend className="mb-2 text-sm">Delivery weekdays</legend><div className="flex flex-wrap gap-4">{[[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]].map(([day, label]) => <label key={day} className="text-sm"><input type="checkbox" checked={policy.weekdays.includes(day)} onChange={() => change("weekdays", policy.weekdays.includes(day) ? policy.weekdays.filter((value) => value !== day) : [...policy.weekdays, day])} /> {label}</label>)}</div></fieldset>
    <div className="flex flex-wrap gap-5">{[["enabled", "Monitoring enabled"], ["paused", "Temporarily paused"], ["acceptEmpty", "An empty import is expected and acceptable"]].map(([key, label]) => <label key={key} className="text-sm"><input disabled={busy} type="checkbox" checked={policy[key]} onChange={(event) => change(key, event.target.checked)} /> {label}</label>)}</div>
    <p className="text-xs leading-5 text-slate-500">Health checks require a known data date. Successful processing is not a guarantee that the source's business data is correct.</p>{error && <p role="alert">{error}</p>}<button disabled={busy} className={primary}>Save delivery expectation</button>
  </form></details>;
}
function RetryImport({ run, hotelUid, onSaved }) {
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [message, setMessage] = useState(null);
  const [requestId, setRequestId] = useState(null);
  const capture = usePlatformScope(hotelUid);
  const retry = async (event) => {
    event.preventDefault(); if (busy) return; setBusy(true); setMessage(null);
    const current = capture();
    const id = requestId || crypto.randomUUID(); setRequestId(id);
    try { const result = await retryPlatformImport({ hotelUid, runId: run.runId, requestId: id, reason });
      if (!current()) return;
      setMessage(result.state === "complete" ? "Import resumed and completed." : result.state === "running" ? "Recovery is still running. Keep this recovery reference and refresh." : "Recovery did not complete. Review the run and recovery history before a new attempt.");
      if (result.state !== "running") { setRequestId(null); await onSaved(); }
    } catch (error) { if (current()) setMessage(platformError(error)); }
    finally { if (current()) setBusy(false); }
  };
  return <details><summary className="cursor-pointer text-xs underline">Review and resume</summary><form onSubmit={retry} className="mt-2 space-y-2"><p className="text-xs">Resume the pinned file while retaining completed checkpoints. This may update hotel records.</p><label className="text-xs">Recovery reason<input required disabled={busy || Boolean(requestId)} maxLength={300} className={field} value={reason} onChange={(event) => setReason(event.target.value)} /></label><button disabled={busy} className={button}>Resume import</button>{message && <p role="status" className="text-xs">{message}</p>}{requestId && <p className="break-all text-xs">Request reference: {requestId}</p>}</form></details>;
}
export default function PlatformImportsPage() {
  const route = useParams(), [selected, setSelected] = useState(""), [hotelCursor, setHotelCursor] = useState(null);
  const hotels = usePlatformQuery(() => listPlatformHotels(hotelCursor), hotelCursor);
  const hotelUid = route.hotelUid || selected;
  const query = usePlatformQuery(async () => hotelUid ? { ...(await getPlatformMonitoring(hotelUid)), hotel: await getPlatformHotel(hotelUid) } : null, hotelUid);
  const [message, setMessage] = useState(null), [busy, setBusy] = useState(false);
  const capture = usePlatformScope(hotelUid);
  useEffect(() => { setBusy(false); setMessage(null); }, [hotelUid]);
  const reconcile = async () => { const current = capture(); setBusy(true); setMessage(null); try { await refreshPlatformMonitoring(hotelUid); if (!current()) return; await query.refresh(); if (current()) setMessage("Monitoring checked and notifications updated."); } catch (error) { if (current()) setMessage(platformError(error)); } finally { if (current()) setBusy(false); } };
  return <><Title title="Imports & integrations" actions={hotelUid && <button disabled={busy || query.loading} className={button} onClick={reconcile}>Check health now</button>}>Inspect delivery expectations and actual processing. Missing telemetry and data dates remain unknown.</Title>
    {!route.hotelUid && <QueryState query={hotels}><div className={`${panel} mb-5`}><label className="text-sm font-medium">Hotel<select className={field} value={selected} onChange={(event) => { setSelected(event.target.value); setMessage(null); }}><option value="">Choose a hotel</option>{hotels.data?.hotels.map((hotel) => <option key={hotel.hotelUid} value={hotel.hotelUid}>{hotel.name}</option>)}</select></label>{hotels.data?.nextCursor && <button className={`${button} mt-3`} onClick={() => setHotelCursor(hotels.data.nextCursor)}>Show next hotels</button>}{hotelCursor && <button className={`${button} ml-2 mt-3`} onClick={() => setHotelCursor(null)}>First page</button>}</div></QueryState>}
    {message && <p role="status" className={`${panel} mb-5`}>{message}</p>}
    {hotelUid ? <QueryState query={query}>{query.data && <div className="space-y-6"><div className={panel}><h2 className="text-xl font-semibold">{query.data.hotel.name}</h2><p className="mt-2 text-sm text-slate-500">Checked: <Moment value={query.data.computedAtMillis} /> · Hotel time zone: {query.data.hotel.timeZone || "Not configured"}</p>{!query.data.monitors.length && <p className="mt-4">No canonical import types are configured for this hotel.</p>}
      {(query.data.historyTruncated || query.data.configurationTruncated) && <p role="status" className="mt-4 text-sm text-amber-900">This bounded view does not contain the full history or configuration. Missing evidence is shown as unknown.</p>}
      <div className="mt-5 space-y-5">{query.data.monitors.map((monitor) => <section key={`${hotelUid}-${monitor.id}-${monitor.policy?.revision || 0}`} className="rounded-xl border p-4"><div className="flex flex-wrap justify-between gap-3"><div><h3 className="font-semibold">{monitor.policy?.label || monitor.label}</h3><p className="mt-1 text-xs text-slate-500">{monitor.fileType}{!monitor.sourceEnabled && " · Source disabled"}</p></div><Status value={monitor.health.status} /></div><div className="mt-3 grid gap-2 text-sm sm:grid-cols-3"><p>Expected data date: {monitor.health.expectedBusinessDate || "Unknown"}</p><p>Deadline: <Moment value={monitor.health.deadlineMillis} timeZone={monitor.policy?.timeZone} /></p><p>Written records: {monitor.health.run?.writtenCount ?? "Unknown"}</p></div><MonitorEditor monitor={monitor} timeZone={query.data.hotel.timeZone} hotelUid={hotelUid} onSaved={query.refresh} /></section>)}</div></div>
      <section className={panel}><h2 className="text-lg font-semibold">Recent import runs</h2><p className="mt-2 text-xs text-slate-500">Up to 100 observations and runs are reconciled. File contents, guest details and source credentials are excluded.</p><div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b"><th className="p-2">Type</th><th className="p-2">Status</th><th className="p-2">Data date</th><th className="p-2">Received</th><th className="p-2">Written records</th><th className="p-2">Recovery</th></tr></thead><tbody>{query.data.observations.map((run) => <tr key={run.runId} className="border-b align-top"><td className="p-2">{run.fileType}<p className="mt-1 max-w-32 truncate text-xs text-slate-500" title={run.runId}>{run.runId}</p></td><td className="p-2"><Status value={run.status} />{run.downstreamStatus === "failed" && <p className="mt-1 text-xs text-amber-900">Follow-up model failed</p>}</td><td className="p-2">{run.businessDate || "Unknown"}</td><td className="p-2"><Moment value={run.receivedAtMillis} /></td><td className="p-2">{run.writtenCount ?? "Unknown"}</td><td className="min-w-40 p-2">{run.retryable && (run.status === "failed" || run.status === "processing" && !(run.leaseUntilMillis > Date.now())) ? <RetryImport run={run} hotelUid={hotelUid} onSaved={query.refresh} /> : "—"}</td></tr>)}</tbody></table>{!query.data.observations.length && <p className="mt-4">No import observations are available.</p>}</div></section>
      <section className={panel}><h2 className="text-lg font-semibold">Recovery history</h2><p className="mt-2 text-xs text-slate-500">The latest 20 requests. A running request requires inspection before starting another recovery.</p>{query.data.recoveryHistoryTruncated && <p className="mt-2 text-sm">Older recovery requests are outside this view.</p>}<ul className="mt-4 space-y-3">{query.data.recoveries?.map((item) => <li key={item.id} className="rounded-lg border p-3 text-sm"><Status value={item.state} /><span className="ml-3"><Moment value={item.startedAtMillis} /></span><p className="mt-2 break-all text-xs">Recovery: {item.id} · Run: {item.runId}</p>{item.errorCode && <p className="mt-1 text-xs">{item.errorCode}</p>}</li>)}</ul>{!query.data.recoveries?.length && <p className="mt-4 text-sm">No recovery requests recorded.</p>}</section>
    </div>}</QueryState> : <p className={panel}>Choose a hotel to inspect or configure its imports.</p>}</>;
}
