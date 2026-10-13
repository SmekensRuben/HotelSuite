import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { auth } from "../../firebaseConfig";
import { useAuthContext } from "../../contexts/AuthContext";
import { usePlatformQuery } from "../../hooks/usePlatformQuery";
import { platformError } from "../../services/firebasePlatform";
import { getPlatformSupplierAiImportSettings, savePlatformSupplierAiImportSettings, listPlatformSupplierAiUsage } from "../../services/firebasePlatformAi";
import { Title, QueryState, button, primary, field, panel } from "./PlatformShared";

const limits = [
  ["maxCostPerImportUsd", "Maximum cost per import (USD)", 0.000001, 0.25, "any", "The cumulative budget for every paid call in one import."],
  ["maxMonthlyCostPerHotelUsd", "Monthly budget per hotel (USD)", 0.000001, 100, "any", "Known charges and reserved possible charges both consume this budget."],
  ["maxConcurrentJobsPerHotel", "Active imports per hotel", 1, 2, 1, "Limit simultaneous background jobs."],
  ["maxImportsPerHotelPerDay", "Daily imports per hotel", 1, 100, 1, "A separate safeguard against repeated starts."],
  ["maxInputTokens", "Input tokens per call", 1000, 200000, 1, "Includes the complete source and request instructions."],
  ["maxOutputTokens", "Output tokens per call", 512, 32000, 1, "Includes reasoning tokens and the structured response."],
  ["maxCallsPerImport", "Paid calls per import", 1, 32, 1, "Limits how many file chunks can be processed within the cumulative import budget."],
];
const usd = (value) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value);
const knownTerminal = new Set(["functions/aborted", "functions/invalid-argument", "functions/failed-precondition", "functions/permission-denied", "functions/unauthenticated"]);

function SettingsForm({ settings, actor, refresh }) {
  const [configuration, setConfiguration] = useState(settings.configuration);
  const [busy, setBusy] = useState(false), [error, setError] = useState(null), [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(null);
  const [current, setCurrent] = useState(settings);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const change = (key, value) => { setConfiguration((old) => ({ ...old, [key]: value })); setSaved(false); setError(null); };
  const save = async (event) => {
    event.preventDefault();
    if (busy || auth.currentUser !== actor) return;
    const command = pending || { configuration: { ...configuration }, expectedRevision: current.revision, requestId: crypto.randomUUID() };
    setPending(command); setBusy(true); setSaved(false); setError(null);
    try {
      const result = await savePlatformSupplierAiImportSettings(command);
      if (!alive.current || auth.currentUser !== actor) return;
      setCurrent(result); setConfiguration(result.configuration); setPending(null); setSaved(true);
    } catch (problem) {
      if (!alive.current || auth.currentUser !== actor) return;
      setError(problem);
      if (knownTerminal.has(problem?.code)) setPending(null);
    } finally { if (alive.current && auth.currentUser === actor) setBusy(false); }
  };
  return <section className={panel} aria-labelledby="ai-settings-title">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="ai-settings-title" className="text-lg font-semibold">Supplier product imports</h2><p className="mt-1 text-sm text-slate-600">One policy and one shared API key for all hotels.</p></div><span className={`rounded-full px-3 py-1 text-xs font-semibold ${current.configuration.enabled ? "bg-emerald-50 text-emerald-800" : "bg-slate-100 text-slate-600"}`}>{current.configuration.enabled ? "Enabled" : "Disabled"}</span></div>
    {!current.configured && <p className="mt-4 rounded-xl bg-slate-50 p-3 text-sm text-slate-600">The configuration has not been saved yet. AI imports remain disabled until you enable them and save.</p>}
    <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6"><p className="font-medium">API key: Google Secret Manager</p><p>The backend uses <code>OPENAI_API_KEY</code>. The key is never loaded or displayed here. Its availability and provider access have not been verified by this page.</p></div>
    <form onSubmit={save} className="mt-5">
      <fieldset disabled={busy || Boolean(pending)} className="space-y-5">
        <label className="flex items-start gap-3 text-sm"><input className="mt-1" type="checkbox" checked={configuration.enabled} onChange={(event) => change("enabled", event.target.checked)} /><span><span className="block font-semibold">Enable AI imports</span><span className="mt-1 block text-slate-600">Allow new billable imports. Existing valid drafts can still be reviewed when disabled.</span></span></label>
        <div className="grid gap-5 sm:grid-cols-2"><div><p className="text-sm font-medium">Model</p><p className="mt-1 rounded-xl border border-slate-200 px-3 py-2 text-sm">gpt-6-luna</p><p className="mt-1 text-xs text-slate-500">The supported, budgeted import model.</p></div><label className="text-sm font-medium">Reasoning effort<select aria-label="Reasoning effort" className={field} value={configuration.reasoningEffort} onChange={(event) => change("reasoningEffort", event.target.value)}><option value="none">None</option><option value="low">Low</option></select><span className="mt-1 block text-xs font-normal text-slate-500">Low may use more output tokens within the same cost ceiling.</span></label></div>
        <p className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900"><strong>Automatic fallback is off.</strong> Imports cannot switch to another model or exceed the configured budget to retry.</p>
        <div className="grid gap-5 sm:grid-cols-2">{limits.slice(0, 4).map(([key, label, min, max, step, description]) => <label key={key} className="text-sm font-medium">{label}<input className={field} aria-label={label} type="number" min={min} max={max} step={step} required value={configuration[key]} onChange={(event) => change(key, event.target.value === "" ? "" : Number(event.target.value))} /><span className="mt-1 block text-xs font-normal leading-5 text-slate-500">{description}</span></label>)}</div>
        <details className="rounded-xl border border-slate-200 p-4"><summary className="cursor-pointer text-sm font-semibold">Advanced token limits</summary><div className="mt-4 grid gap-5 sm:grid-cols-2">{limits.slice(4).map(([key, label, min, max, step, description]) => <label key={key} className="text-sm font-medium">{label}<input className={field} aria-label={label} type="number" min={min} max={max} step={step} required value={configuration[key]} onChange={(event) => change(key, event.target.value === "" ? "" : Number(event.target.value))} /><span className="mt-1 block text-xs font-normal leading-5 text-slate-500">{description}</span></label>)}</div></details>
      </fieldset>
      {error && <div role="alert" className="mt-4 text-sm text-red-700"><p>{platformError(error)}</p>{pending && <p className="mt-1">The save response is uncertain. Retry the same change, or refresh to inspect the stored settings.</p>}</div>}
      {saved && <p role="status" className="mt-4 text-sm text-emerald-700">AI import settings saved.</p>}
      <div className="mt-5 flex flex-wrap items-center gap-3"><button type="submit" className={primary} disabled={busy}>{busy ? "Saving..." : pending ? "Retry saving the same settings" : "Save AI settings"}</button><button type="button" className={button} disabled={busy} onClick={refresh}>Refresh settings</button><p className="text-xs text-slate-500">Policy {current.configuration.policyVersion} · Revision {current.revision}</p></div>
    </form>
  </section>;
}

function HotelUsage({ hotel }) {
  const usage = hotel.usage;
  return <article className="rounded-xl border border-slate-200 p-4"><div className="flex flex-wrap items-start justify-between gap-2"><Link className="font-semibold underline decoration-slate-300 underline-offset-4" to={`/platform/hotels/${encodeURIComponent(hotel.id)}`}>{hotel.name || hotel.id}</Link><span className="text-xs text-slate-500">{hotel.id}</span></div>
    {usage.state === "none" ? <p className="mt-3 text-sm text-slate-500">No recorded AI import usage for this month.</p> : usage.state === "unavailable" ? <p role="alert" className="mt-3 text-sm text-amber-800">Usage is unavailable. Totals cannot be verified.</p> : <>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4 lg:grid-cols-4">{[["Imports started", usage.importsStarted], ["Paid attempts", usage.attemptedCalls], ["Known spend", usd(usage.knownCostUsd)], ["Reserved possible charges", usd(usage.reservedCostUsd)]].map(([label, value]) => <div key={label}><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-1 text-base font-semibold text-slate-900">{value}</dd></div>)}</dl>
      {usage.unknownCalls > 0 && <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Total cost is unknown: {usage.unknownCalls} paid {usage.unknownCalls === 1 ? "response has" : "responses have"} unverified charges. Known spend excludes these calls; possible charges remain reserved.</p>}
      {usage.unknownCalls === 0 && usage.actualCostUsd === null && <p className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">Total cost is pending while a paid call is in progress. Possible charges remain reserved.</p>}
      <p className="mt-4 text-xs leading-5 text-slate-500">Confirmed calls: {usage.succeededCalls} · Token counts: {usage.countingCalls} · Verified input tokens: {usage.inputTokens.toLocaleString("en-US")} · Verified output tokens: {usage.outputTokens.toLocaleString("en-US")}</p>
      {[["reviewReadyJobs", "Drafts ready"], ["failedJobs", "Failed jobs"], ["committedJobs", "Committed jobs"]].some(([key]) => Number.isSafeInteger(usage[key]) && usage[key] >= 0) && <p className="mt-1 text-xs text-slate-500">{[["reviewReadyJobs", "Drafts ready"], ["failedJobs", "Failed jobs"], ["committedJobs", "Committed jobs"]].filter(([key]) => Number.isSafeInteger(usage[key]) && usage[key] >= 0).map(([key, label]) => `${label}: ${usage[key]}`).join(" · ")}</p>}
    </>}
  </article>;
}

function PlatformAiWorkspace({ actor, scope }) {
  const settings = usePlatformQuery(getPlatformSupplierAiImportSettings, `${scope}:settings`);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [cursor, setCursor] = useState(null), [previous, setPrevious] = useState([]);
  const usage = usePlatformQuery(() => listPlatformSupplierAiUsage({ month, cursor, pageSize: 25 }), `${scope}:${month}:${cursor || "first"}`);
  return <div className="mx-auto max-w-6xl"><Title title="AI settings & usage">Control supplier product import costs for every hotel. Each file produces a draft for review before any products are written.</Title>
    <QueryState query={settings}>{settings.data && <SettingsForm key={`${scope}:${settings.data.revision}`} settings={settings.data} actor={actor} refresh={settings.refresh} />}</QueryState>
    <section className={`${panel} mt-6`} aria-labelledby="ai-usage-title"><div className="flex flex-wrap items-start justify-between gap-4"><div><h2 id="ai-usage-title" className="text-lg font-semibold">Usage per hotel</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">USD estimates use the versioned model pricing. Reserved possible charges consume the budget until verified; they are not confirmed spend.</p></div><label className="text-sm font-medium">Usage month<input className={field} type="month" required value={month} onChange={(event) => { if (/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)) { setMonth(event.target.value); setCursor(null); setPrevious([]); } }} /></label></div>
      <div className="mt-5"><QueryState query={usage}>{usage.data && <><div className="space-y-3">{usage.data.hotels.map((hotel) => <HotelUsage key={hotel.id} hotel={hotel} />)}</div>{!usage.data.hotels.length && <p className="text-sm text-slate-500">No hotels are available on this page.</p>}<div className="mt-5 flex flex-wrap items-center justify-between gap-3"><button className={button} disabled={!previous.length} onClick={() => { setCursor(previous.at(-1)); setPrevious(previous.slice(0, -1)); }}>Previous hotels</button><button className={button} onClick={usage.refresh}>Refresh usage</button><button className={button} disabled={!usage.data.nextCursor} onClick={() => { setPrevious([...previous, cursor]); setCursor(usage.data.nextCursor); }}>Next hotels</button></div></>}</QueryState></div>
    </section>
  </div>;
}

export default function PlatformAiPage() {
  const { currentUser, isPlatformAdmin, authLoading } = useAuthContext();
  const session = useRef({ actor: currentUser, generation: 0 });
  if (session.current.actor !== currentUser) session.current = { actor: currentUser, generation: session.current.generation + 1 };
  if (authLoading) return <p role="status" className={panel}>Checking platform access...</p>;
  if (!isPlatformAdmin || !currentUser?.emailVerified || auth.currentUser !== currentUser) return <p role="alert" className={panel}>Your current platform access could not be verified. Sign in again.</p>;
  const scope = `${currentUser.uid}:${session.current.generation}`;
  return <PlatformAiWorkspace key={scope} scope={scope} actor={currentUser} />;
}
