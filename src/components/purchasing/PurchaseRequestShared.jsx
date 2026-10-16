import React from "react";
import { purchaseRequestMoney, purchaseRequestStatusLabel } from "../../utils/purchaseRequests";

export const requestFieldClass = "mt-1 block min-h-[44px] w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-base disabled:bg-stone-100";
export function RequestStatus({ status }) {
  const color = status === "approved" ? "bg-emerald-100 text-emerald-900" : ["pending", "returned"].includes(status) ? "bg-amber-100 text-amber-950" : "bg-stone-100 text-stone-700";
  return <span className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${color}`}>{purchaseRequestStatusLabel(status)}</span>;
}
export function RequestError({ error, onRetry }) {
  if (!error) return null;
  return <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900"><p>{error.message || error}</p>{onRetry && <button type="button" className="ht-button-secondary mt-3" onClick={onRetry}>Try again</button>}</div>;
}
export function RequestBudgetSummary({ budget, currency, totalMinor, heldMinor = 0, title = "Budget impact", missing, afterMinor, overBudget, compact = false }) {
  const available = budget?.remainingMinor;
  if (compact) return <section aria-label={title} className={`rounded-lg px-4 py-3 ${missing || overBudget ? "bg-amber-50 text-amber-950" : "bg-stone-50"}`}>
    <h2 className="text-sm font-semibold">{title}</h2>
    {missing ? <p className="mt-2 text-sm">No budget is configured for this category and month. Configure it before submitting.</p> : <dl className="mt-2 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
      <div><dt className="text-xs text-stone-600">Currently available</dt><dd className="mt-1 font-semibold tabular-nums">{purchaseRequestMoney(available, currency)}</dd></div>
      <div><dt className="text-xs text-stone-600">This request</dt><dd className="mt-1 font-semibold tabular-nums">{purchaseRequestMoney(totalMinor, currency)}</dd></div>
      <div><dt className="text-xs text-stone-600">Available after submission</dt><dd className="mt-1 font-semibold tabular-nums">{purchaseRequestMoney(afterMinor ?? (Number(available || 0) + heldMinor - totalMinor), currency)}</dd></div>
    </dl>}
    {overBudget && <p className="mt-2 text-sm">This request exceeds the available budget. Submission follows the hotel's over-budget approval policy.</p>}
  </section>;
  return <section aria-label={title} className={`rounded-xl border p-4 ${missing || overBudget ? "border-amber-300 bg-amber-50" : "border-stone-200 bg-stone-50"}`}><h2 className="font-semibold">{title}</h2><p className="mt-1 text-xs text-stone-600">All amounts are net, excluding VAT. The chosen budget month stays fixed.</p>{missing ? <p className="mt-3 text-sm font-medium">No budget is configured for this category and month. Configure it before submitting.</p> : <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3"><div><dt className="text-stone-600">Currently available</dt><dd className="font-semibold">{purchaseRequestMoney(available, currency)}</dd></div><div><dt className="text-stone-600">This request</dt><dd className="font-semibold">{purchaseRequestMoney(totalMinor, currency)}</dd></div><div><dt className="text-stone-600">Available after submission</dt><dd className={`font-semibold ${overBudget ? "text-amber-950" : ""}`}>{purchaseRequestMoney(afterMinor ?? (Number(available || 0) + heldMinor - totalMinor), currency)}</dd></div></dl>}{overBudget && <p className="mt-3 text-sm font-medium">This request exceeds the available budget. Submission follows the hotel's over-budget approval policy.</p>}</section>;
}
export function RequestRecovery({ pending, disabled, onRetry }) {
  if (!pending) return null;
  return <section aria-label="Recover purchase request command" className="rounded-xl border border-amber-300 bg-amber-50 p-4"><h2 className="font-semibold">An earlier action needs confirmation</h2><p className="mt-1 text-sm">Recover the original {pending.input?.action || "save"} action before making another change. Retrying uses the same command and cannot reserve the amount twice.</p><button type="button" className="ht-button-secondary mt-3" disabled={disabled} onClick={onRetry}>Recover original action</button></section>;
}
