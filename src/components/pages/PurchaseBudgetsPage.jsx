import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import AsyncError from "../shared/AsyncError";
import { auth, signOut } from "../../firebaseConfig";
import { usePermission } from "../../hooks/usePermission";
import { useProcurementSettingsScope } from "../../hooks/useProcurementSettingsScope";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { getPurchaseBudgets, savePurchaseBudgets, getPendingPurchaseBudgetCommand, retryPurchaseBudgetCommand } from "../../services/firebasePurchaseRequests";
import { MAX_PURCHASE_BUDGET_CHANGES, PURCHASE_BUDGET_MONTHS, buildPurchaseBudgetDraft, changedPurchaseBudgets, purchaseBudgetChangeCount, purchaseBudgetDraftAmounts, purchaseBudgetKey, purchaseBudgetViewTotals, purchaseMoneyToMinor, purchaseMinorToInput } from "../../utils/purchaseBudgetDraft";

export default function PurchaseBudgetsPage() {
  const scope = useProcurementSettingsScope();
  const canRead = usePermission("purchasebudgets", "read");
  return <div className="min-h-screen bg-canvas text-gray-900">
    <HeaderBar today={new Date().toLocaleDateString()} onLogout={async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; }} />
    <ProcurementPage className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-widest text-gray-500">Purchasing &amp; Inventory</p><h1 className="mt-1 text-3xl font-semibold">Purchase budgets</h1><p className="mt-2 text-sm text-gray-600">Plan a month across categories, or review one category throughout the year.</p></div><Link to="/purchase-requests" className="ht-button-secondary">Purchase requests</Link></div>
      {canRead ? <BudgetYearSelection key={scope.scopeKey} scope={scope} /> : <p role="alert">You do not have permission to view purchase budgets.</p>}
    </ProcurementPage>
  </div>;
}

function BudgetYearSelection({ scope }) {
  const [year, setYear] = useState(new Date().getFullYear());
  return <ScopedPurchaseBudgets key={`${scope.scopeKey}:${year}`} scope={scope} year={year} setYear={setYear} />;
}

function ScopedPurchaseBudgets({ scope, year, setYear }) {
  const { hotelUid, current } = scope;
  const canUpdate = usePermission("purchasebudgets", "update"), canConfigure = usePermission("purchasebudgets", "settings");
  const load = useCallback(() => getPurchaseBudgets(hotelUid, year), [hotelUid, year]);
  const query = useScopedAsync({ scopeKey: `${scope.scopeKey}:${year}`, enabled: Boolean(hotelUid), retainData: true, load });
  const [draft, setDraft] = useState({}), [categoryId, setCategoryId] = useState("");
  const [view, setView] = useState("month"), [selectedMonth, setSelectedMonth] = useState(String(new Date().getMonth() + 1).padStart(2, "0"));
  const [pending, setPending] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(null), [notice, setNotice] = useState("");
  const [sourceMonth, setSourceMonth] = useState("01"), [targetMonths, setTargetMonths] = useState(PURCHASE_BUDGET_MONTHS.map((_, index) => String(index + 1).padStart(2, "0")));
  const [sourceYear, setSourceYear] = useState(year - 1);
  const categories = query.data?.budgetCategories || [], budgets = query.data?.budgets || [];
  const currency = query.data?.currency || "EUR";
  const savedDraft = useMemo(() => buildPurchaseBudgetDraft(budgets), [budgets]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(savedDraft);
  const locked = !canUpdate || busy || Boolean(pending) || query.loading || Boolean(query.error);
  const money = (minor) => Number.isSafeInteger(minor) ? new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 100) : "—";
  const changedCount = purchaseBudgetChangeCount(draft, budgets);
  const rowByKey = new Map(budgets.map((row) => [purchaseBudgetKey(row.month, row.categoryId), row]));
  const activeCategory = categories.find((category) => category.id === categoryId);
  const monthLabel = PURCHASE_BUDGET_MONTHS[Number(selectedMonth) - 1];
  const heading = view === "month" ? `${monthLabel} ${year}` : `${activeCategory?.name || "Budget category"} · ${year}`;
  const visibleRows = (view === "month" ? categories.map((category) => ({ month: `${year}-${selectedMonth}`, categoryId: category.id, label: category.name }))
    : PURCHASE_BUDGET_MONTHS.map((label, index) => ({ month: `${year}-${String(index + 1).padStart(2, "0")}`, categoryId, label })))
    .map((row) => { const key = purchaseBudgetKey(row.month, row.categoryId); return { ...row, key, saved: rowByKey.get(key), draft: draft[key] || { budget: "", opening: "" } }; });
  const totals = purchaseBudgetViewTotals(visibleRows);
  useEffect(() => {
    if (!query.data) return;
    setDraft(buildPurchaseBudgetDraft(query.data.budgets));
    setCategoryId((previous) => query.data.budgetCategories?.some((category) => category.id === previous) ? previous : query.data.budgetCategories?.[0]?.id || "");
  }, [query.data]);
  useEffect(() => {
    try { setPending(getPendingPurchaseBudgetCommand(hotelUid)); }
    catch (failure) { setError(failure); }
  }, [hotelUid]);
  const setCell = (month, rowCategoryId, field, value) => {
    const key = purchaseBudgetKey(month, rowCategoryId);
    setDraft((previous) => ({ ...previous, [key]: { budget: "", opening: "", ...previous[key], [field]: value } }));
  };
  const save = async (retry = false) => {
    if (!current() || busy || !canUpdate || !query.data) return;
    setBusy(true); setError(null); setNotice("");
    try {
      if (retry) await retryPurchaseBudgetCommand(hotelUid);
      else {
        const changed = changedPurchaseBudgets(draft, budgets, year, categories);
        if (!changed.length) { setDraft(savedDraft); setNotice("No changed allocations to save."); return; }
        await savePurchaseBudgets(hotelUid, { budgets: changed });
      }
      if (!current()) return;
      setPending(null); setNotice(retry ? "The original budget save has been verified." : "Budget allocations saved."); await query.retry();
    } catch (failure) {
      if (!current()) return;
      setError(failure);
      try { setPending(getPendingPurchaseBudgetCommand(hotelUid)); } catch (recoveryFailure) { setError(recoveryFailure); }
    } finally { if (current()) setBusy(false); }
  };
  const copyMonth = () => {
    setError(null); setNotice("");
    try {
      const source = draft[purchaseBudgetKey(`${year}-${sourceMonth}`, categoryId)]?.budget ?? "";
      if (!source.trim()) throw new Error("Enter the source month's allocation before copying it.");
      purchaseMoneyToMinor(source);
      setDraft((previous) => {
        const next = { ...previous };
        for (const month of targetMonths) {
          const key = purchaseBudgetKey(`${year}-${month}`, categoryId);
          next[key] = { opening: "", ...next[key], budget: source };
        }
        return next;
      });
      setNotice("Allocation copied into the selected months. Review and save your changes.");
    } catch (failure) { setError(failure); }
  };
  const copyYear = async () => {
    if (!current() || locked || !categoryId) return;
    setBusy(true); setError(null); setNotice("");
    try {
      const previousYear = await getPurchaseBudgets(hotelUid, Number(sourceYear));
      if (!current()) return;
      const sourceRows = previousYear.budgets.filter((row) => row.categoryId === categoryId);
      if (!sourceRows.length) throw new Error("No configured allocations for this category in the source year.");
      setDraft((previous) => {
        const next = { ...previous };
        for (const row of sourceRows) {
          const key = purchaseBudgetKey(`${year}-${row.month.slice(5)}`, categoryId);
          next[key] = { opening: "", ...next[key], budget: purchaseMinorToInput(row.budgetMinor) };
        }
        return next;
      });
      setNotice(`Allocations copied from ${sourceYear}. Opening consumption and commitments were not copied. Review and save your changes.`);
    } catch (failure) { if (current()) setError(failure); }
    finally { if (current()) setBusy(false); }
  };
  return <div className="space-y-5">
    <div className="flex flex-wrap items-end gap-4 rounded-xl border border-gray-200 bg-white p-4">
      <div className="w-full sm:w-auto"><p className="mb-1 text-sm font-medium">View budgets</p><div role="group" aria-label="Budget view" className="inline-flex rounded-lg border border-gray-300 p-1">{[["month", "By month"], ["category", "By category"]].map(([value, label]) => <button key={value} type="button" aria-pressed={view === value} disabled={busy} className={`rounded-md px-4 py-2 text-sm font-medium ${view === value ? "bg-brand-800 text-white" : "text-gray-600 hover:bg-gray-50"}`} onClick={() => setView(value)}>{label}</button>)}</div></div>
      <label className="text-sm font-medium">Budget year<select aria-label="Budget year" value={year} disabled={busy || Boolean(pending) || dirty} className="ht-field mt-1 block" onChange={(event) => setYear(Number(event.target.value))}>{Array.from({ length: 16 }, (_, index) => new Date().getFullYear() - 10 + index).map((value) => <option key={value}>{value}</option>)}</select></label>
      {view === "month" ? <label className="min-w-[160px] flex-1 text-sm font-medium sm:max-w-xs">Month<select aria-label="Budget month" value={selectedMonth} disabled={busy} className="ht-field mt-1 w-full" onChange={(event) => setSelectedMonth(event.target.value)}>{PURCHASE_BUDGET_MONTHS.map((label, index) => <option key={label} value={String(index + 1).padStart(2, "0")}>{label}</option>)}</select></label>
        : categories.length > 0 && <label className="min-w-[200px] flex-1 text-sm font-medium sm:max-w-sm">Budget category<select aria-label="Budget category" value={categoryId} disabled={busy} className="ht-field mt-1 w-full" onChange={(event) => setCategoryId(event.target.value)}>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>}
      <span className="pb-2 text-xs font-semibold text-gray-600">{currency} · Net, excluding VAT</span>
      {canConfigure && <Link to="/settings/procurement?section=purchase-requests" className="pb-2 text-sm text-brand-800 underline">Approval and category settings</Link>}
    </div>
    {dirty && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Unsaved changes are kept when you switch month, category or view. Save or discard them before changing the year.</p>}
    <AsyncError error={query.error} onRetry={query.retry} label="Could not load purchase budgets." />
    {query.loading && <p role="status">Loading annual budgets…</p>}
    {query.data && <>
      {!categories.length ? <section className="space-y-3 rounded-xl border border-dashed border-gray-300 bg-white p-6"><h2 className="text-lg font-semibold">Set up your first budget category</h2><p className="text-sm text-gray-600">Add categories such as Chinaware or Maintenance in Purchase Request settings. Cost centres identify departments separately.</p>{canConfigure ? <Link to="/settings/procurement?section=purchase-requests" className="ht-button-primary inline-block">Configure Purchase Requests</Link> : <p className="text-sm text-gray-500">Ask a user with Purchase Budgets settings permission to configure the hotel.</p>}</section>
        : <>
          <section aria-label="Budget summary" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-xl font-semibold">{heading}</h2><p className="mt-1 text-sm text-gray-600">{view === "month" ? "All budget categories for this month" : "All 12 months for this budget category"} · {dirty ? "Includes unsaved changes" : "Saved amounts"}</p></div><span className={`rounded-full px-3 py-1 text-xs font-medium ${totals.complete ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900"}`}>{totals.configured} of {totals.count} {view === "month" ? "categories" : "months"} configured</span></div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">{[[totals.complete ? "Total allocation" : "Known allocations", totals.allocated], ["Opening consumption", totals.opening], ["Pending requests", totals.pending], ["Approved commitments", totals.committed], ["Total remaining", totals.remaining]].map(([label, value]) => <div key={label} className="rounded-xl border border-gray-200 bg-white p-3"><p className="text-xs text-gray-600">{label}</p><p className={`mt-1 text-lg font-semibold ${value !== null && value < 0 ? "text-red-700" : ""}`}>{money(value)}</p></div>)}</div>
            {!totals.complete && <p className="text-xs text-amber-800">Known allocations are a subtotal. Total remaining is unavailable until every {view === "month" ? "category in this month" : "month in this category"} has a valid allocation and opening consumption.{totals.invalid > 0 && " Correct the highlighted invalid amounts."}</p>}
            <p className="text-xs text-gray-500">Remaining = allocation − opening consumption − pending requests − approved commitments. Commitments are saved purchase request amounts, not invoice costs. Each allocation applies to the whole hotel; cost centres do not have separate budgets.</p>
          </section>
          <section aria-label="Budget allocations" className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <div className="border-b border-gray-100 p-4"><h3 className="font-semibold">{view === "month" ? "Category allocations" : "Monthly allocations"}</h3><p className="mt-1 text-xs text-gray-500">Blank means not configured. Enter 0.00 for an explicit zero budget. Opening consumption records spending before this workflow was adopted.</p></div>
            <div className="sm:overflow-x-auto"><table className="block w-full text-sm sm:table"><thead className="hidden bg-gray-50 text-left text-xs text-gray-600 sm:table-header-group"><tr><th className="p-3">{view === "month" ? "Budget category" : "Month"}</th><th className="p-3">Allocation</th><th className="p-3">Opening used</th><th className="p-3">Pending</th><th className="p-3">Approved</th><th className="p-3">Remaining</th></tr></thead><tbody className="block divide-y divide-gray-100 sm:table-row-group">
              {visibleRows.map((row) => {
                const values = purchaseBudgetDraftAmounts(row.draft, row.saved);
                return <tr key={row.key} className={`block p-3 sm:table-row sm:p-0 ${values.invalid ? "bg-amber-50/60" : values.remaining !== null && values.remaining < 0 ? "bg-red-50/50" : ""}`}>
                  <th scope="row" className="block pb-2 text-left font-medium sm:table-cell sm:p-3">{row.label}{values.invalid ? <span className="mt-1 block text-xs font-normal text-amber-800">Check invalid amounts</span> : !values.configured && <span className="mt-1 block text-xs font-normal text-amber-700">Not configured</span>}</th>
                  <td className="flex items-center justify-between gap-3 py-1 sm:table-cell sm:p-2"><span className="text-gray-500 sm:hidden">Allocation</span><input aria-label={`${row.label} allocation`} inputMode="decimal" type="text" value={row.draft.budget} disabled={locked} placeholder="Not set" onChange={(event) => setCell(row.month, row.categoryId, "budget", event.target.value)} className="ht-field w-28 text-right" /></td>
                  <td className="flex items-center justify-between gap-3 py-1 sm:table-cell sm:p-2"><span className="text-gray-500 sm:hidden">Opening used</span><input aria-label={`${row.label} opening consumption`} inputMode="decimal" type="text" value={row.draft.opening} disabled={locked} placeholder="0.00" onChange={(event) => setCell(row.month, row.categoryId, "opening", event.target.value)} className="ht-field w-28 text-right" /></td>
                  {[["Pending", values.pending], ["Approved", values.committed], ["Remaining", values.remaining]].map(([label, value]) => <td key={label} className={`flex items-center justify-between gap-3 whitespace-nowrap py-1 tabular-nums sm:table-cell sm:p-3 ${label === "Remaining" ? "font-semibold" : ""} ${value !== null && value < 0 ? "text-red-700" : ""}`}><span className="font-normal text-gray-500 sm:hidden">{label}</span>{money(value)}</td>)}
                </tr>;
              })}
            </tbody></table></div>
          </section>
          {canUpdate && <details className="rounded-xl border border-gray-200 bg-white p-4"><summary className="cursor-pointer font-medium">Copy allocations</summary><div className="mt-4 space-y-5">
            {view === "month" ? <label className="block max-w-sm text-sm font-medium">Category to copy<select aria-label="Copy budget category" value={categoryId} disabled={locked} className="ht-field mt-1 w-full" onChange={(event) => setCategoryId(event.target.value)}>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label> : <p className="text-sm text-gray-600">Copy allocations for <strong className="font-semibold text-gray-900">{activeCategory?.name}</strong>.</p>}
            <div className="space-y-3"><h3 className="text-sm font-semibold">Apply one month to selected months</h3><label className="block max-w-xs text-sm">Copy from<select aria-label="Copy allocation from month" value={sourceMonth} disabled={locked} className="ht-field mt-1 w-full" onChange={(event) => setSourceMonth(event.target.value)}>{PURCHASE_BUDGET_MONTHS.map((label, index) => <option key={label} value={String(index + 1).padStart(2, "0")}>{label}</option>)}</select></label><fieldset disabled={locked} className="flex flex-wrap gap-x-4 gap-y-2"><legend className="mb-2 text-xs text-gray-500">Apply to months</legend>{PURCHASE_BUDGET_MONTHS.map((label, index) => { const month = String(index + 1).padStart(2, "0"); return <label key={month} className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label={`Copy to ${label}`} checked={targetMonths.includes(month)} onChange={(event) => setTargetMonths(event.target.checked ? [...targetMonths, month] : targetMonths.filter((item) => item !== month))} />{label.slice(0, 3)}</label>; })}</fieldset><button type="button" className="ht-button-secondary" disabled={locked || !targetMonths.length} onClick={copyMonth}>Apply allocation to selected months</button></div>
            <div className="flex flex-wrap items-end gap-3 border-t border-gray-100 pt-4"><label className="text-sm">Copy this category from year<input aria-label="Copy allocations from year" type="number" min="2000" max="2100" value={sourceYear} disabled={locked} className="ht-field mt-1 block w-28" onChange={(event) => setSourceYear(event.target.value)} /></label><button type="button" disabled={locked || Number(sourceYear) === year || Number(sourceYear) < 2000 || Number(sourceYear) > 2100} onClick={copyYear} className="ht-button-secondary">Copy year allocations</button></div>
            <p className="text-xs text-gray-500">Copying changes only {activeCategory?.name || "the selected category"}'s allocations in your draft. Opening consumption, pending requests and approved commitments stay in their original months. Existing draft allocations in the target months are replaced.</p>
          </div></details>}
          {changedCount > 0 && <p className={`text-xs ${changedCount > MAX_PURCHASE_BUDGET_CHANGES ? "text-red-700" : "text-gray-500"}`}>{changedCount} changed monthly allocations across categories. Save up to {MAX_PURCHASE_BUDGET_CHANGES} together. {changedCount > MAX_PURCHASE_BUDGET_CHANGES && "Discard a category's draft changes to reduce the batch, then save before editing more categories."}</p>}
          <div className="sticky bottom-3 z-10 flex flex-wrap gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm"><button type="button" className="ht-button-primary" disabled={locked || !dirty || changedCount > MAX_PURCHASE_BUDGET_CHANGES} onClick={() => save()}>{busy ? "Saving…" : "Save budget changes"}</button>{dirty && <>{view === "category" && <button type="button" disabled={busy || Boolean(pending)} className="ht-button-secondary" onClick={() => {
            setDraft((previous) => {
              const next = { ...previous };
              for (const key of Object.keys(next)) if (key.endsWith(`:${categoryId}`)) { if (savedDraft[key]) next[key] = savedDraft[key]; else delete next[key]; }
              return next;
            }); setError(null); setNotice("");
          }}>Discard this category's changes</button>}<button type="button" disabled={busy || Boolean(pending)} className="ht-button-secondary" onClick={() => { setDraft(savedDraft); setError(null); setNotice(""); }}>Discard all changes</button></>}</div>
          {!canUpdate && <p className="text-xs text-gray-500">Purchase Budgets update permission is required to change allocations.</p>}
        </>}
    </>}
    {pending && <div role="status" className="space-y-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900"><p>A previous budget save needs verification. Editing is paused so its original values can be recovered safely.</p><button type="button" className="ht-button-secondary" disabled={busy || !canUpdate || query.loading || !query.data} onClick={() => save(true)}>Verify original budget save</button></div>}
    <AsyncError error={error} label="Could not update purchase budgets." />
    {error && !pending && <button type="button" className="ht-button-secondary" disabled={busy || query.loading} onClick={() => { setError(null); query.retry(); }}>Reload saved budgets and discard draft changes</button>}
    {notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}
  </div>;
}
