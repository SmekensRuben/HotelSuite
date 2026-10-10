import React from "react";
import { platformError } from "../../services/firebasePlatform";

export const button = "rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50";
export const primary = "rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50";
export const field = "mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2";
export const panel = "rounded-2xl border border-slate-200 bg-white p-5 sm:p-6";
export function Moment({ value, timeZone }) {
  return value == null ? <span>Unknown</span> : <time dateTime={new Date(value).toISOString()}>{new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", ...(timeZone ? { timeZone } : {}) }).format(new Date(value))}</time>;
}
export function Status({ value = "unknown" }) {
  const tone = ["healthy", "active", "succeeded", "complete", "resolved"].includes(value) ? "bg-emerald-50 text-emerald-800"
    : ["failed", "overdue", "stalled", "attention", "partial", "empty", "open"].includes(value) ? "bg-amber-50 text-amber-900" : "bg-slate-100 text-slate-600";
  return <span className={`inline-block rounded-full px-3 py-1 text-xs font-semibold ${tone}`}>{value.replace(/-/g, " ")}</span>;
}
export function QueryState({ query, children }) {
  if (query.loading) return <p role="status" className={panel}>Loading platform data...</p>;
  if (query.error) return <div role="alert" className={panel}><p>{platformError(query.error)}</p><button className={`${button} mt-4`} onClick={query.refresh}>Try again</button></div>;
  return children;
}
export function Title({ title, children, actions }) {
  return <div className="mb-6 flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Platform administration</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">{title}</h1>{children && <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">{children}</p>}</div>{actions}</div>;
}
