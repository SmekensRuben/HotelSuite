import React, { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { useProcurementSettingsScope } from "../../hooks/useProcurementSettingsScope";
import { usePermission } from "../../hooks/usePermission";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { getPurchaseRequestSettings, savePurchaseRequestSettings, getPendingPurchaseRequestCommand, retryPurchaseRequestCommand } from "../../services/firebasePurchaseRequests";
import { purchaseMinorToInput, purchaseMoneyToMinor } from "../../utils/purchaseBudgetDraft";
import AsyncError from "../shared/AsyncError";

const defaultSettings = { currency: "EUR", costCentres: [], budgetCategories: [], approvalSteps: [], approvers: [], overBudgetMode: "block" };
const fieldClass = "ht-field w-full";
const newId = () => crypto.randomUUID();
function toDraft(settings) {
  return { ...defaultSettings, ...settings,
    approvalSteps: (settings?.approvalSteps || []).map((step) => ({ ...step, threshold: purchaseMinorToInput(step.thresholdMinor || 0) })),
    approvers: (settings?.approvers || []).map((person) => ({ ...person, limit: purchaseMinorToInput(person.limitMinor || 0) })),
  };
}
function toSettings(draft) {
  return { currency: draft.currency, overBudgetMode: draft.overBudgetMode,
    costCentres: draft.costCentres.map(({ id, name }) => ({ id, name: name.trim() })),
    budgetCategories: draft.budgetCategories.map(({ id, name }) => ({ id, name: name.trim() })),
    approvalSteps: draft.approvalSteps.map(({ id, name, threshold }) => ({ id, name: name.trim(), thresholdMinor: purchaseMoneyToMinor(threshold) })),
    approvers: draft.approvers.map(({ uid, stepIds, limit, canApproveOverBudget }) => ({ uid, stepIds, limitMinor: purchaseMoneyToMinor(limit), canApproveOverBudget: canApproveOverBudget === true })),
  };
}

export default function PurchaseRequestSettingsSection() {
  const scope = useProcurementSettingsScope();
  const allowed = usePermission("purchasebudgets", "settings");
  return allowed ? <ScopedPurchaseRequestSettings key={scope.scopeKey} scope={scope} /> : null;
}

function NamedList({ title, description, items, setItems, disabled, singular }) {
  return <section className="space-y-3 rounded-xl border border-gray-200 p-4">
    <div><h3 className="font-semibold">{title}</h3><p className="mt-1 text-sm text-gray-600">{description}</p></div>
    {items.map((item, index) => <div key={item.id} className="flex items-center gap-2">
      <label className="min-w-0 flex-1"><span className="sr-only">{singular} {index + 1} name</span><input aria-label={`${singular} ${index + 1} name`} required maxLength={100} value={item.name} disabled={disabled}
        onChange={(event) => setItems(items.map((entry) => entry.id === item.id ? { ...entry, name: event.target.value } : entry))} className={fieldClass} /></label>
      <button type="button" aria-label={`Remove ${singular.toLowerCase()} ${index + 1}`} disabled={disabled} onClick={() => setItems(items.filter((entry) => entry.id !== item.id))} className="min-h-[44px] rounded-lg p-2 text-gray-500 hover:bg-red-50 hover:text-red-700 disabled:opacity-50"><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
    </div>)}
    {!items.length && <p className="text-sm text-gray-500">No {title.toLowerCase()} configured.</p>}
    <button type="button" className="ht-button-secondary inline-flex items-center gap-2" disabled={disabled || items.length >= 100} onClick={() => setItems([...items, { id: newId(), name: "" }])}><Plus className="h-4 w-4" aria-hidden="true" />Add {singular.toLowerCase()}</button>
  </section>;
}

function ScopedPurchaseRequestSettings({ scope }) {
  const { hotelUid, current } = scope;
  const load = useCallback(() => getPurchaseRequestSettings(hotelUid), [hotelUid]);
  const query = useScopedAsync({ scopeKey: scope.scopeKey, enabled: Boolean(hotelUid), retainData: true, load });
  const [draft, setDraft] = useState(null), [error, setError] = useState(null), [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false), [pending, setPending] = useState(null);
  useEffect(() => { if (query.data) setDraft(toDraft(query.data.settings)); }, [query.data]);
  useEffect(() => {
    try { setPending(getPendingPurchaseRequestCommand(hotelUid, "settings")); }
    catch (failure) { setError(failure); }
  }, [hotelUid]);
  const locked = busy || Boolean(pending) || query.loading || Boolean(query.error);
  const update = (key, value) => setDraft((previous) => ({ ...previous, [key]: value }));
  const userOptions = query.data?.users || query.data?.approvers || [];
  const availableUsers = userOptions.filter((person) => person.eligible !== false && !draft?.approvers.some((entry) => entry.uid === person.uid));
  const personLabel = (uid) => {
    const user = userOptions.find((person) => person.uid === uid) || query.data?.approvers?.find((person) => person.uid === uid);
    return user ? user.displayName || user.name || user.email || uid : `${uid} (review access)`;
  };
  const save = async (retry = false) => {
    if (busy || !current() || !draft || !query.data) return;
    setBusy(true); setError(null); setNotice("");
    try {
      if (retry) await retryPurchaseRequestCommand(hotelUid, "settings");
      else await savePurchaseRequestSettings(hotelUid, { expectedRevision: query.data.revision || 0, settings: toSettings(draft) });
      if (!current()) return;
      setPending(null); setNotice("Purchase Request settings saved."); await query.retry();
    } catch (failure) {
      if (!current()) return;
      setError(failure);
      try { setPending(getPendingPurchaseRequestCommand(hotelUid, "settings")); } catch (recoveryFailure) { setError(recoveryFailure); }
    } finally { if (current()) setBusy(false); }
  };
  const moveStep = (index, offset) => {
    const steps = [...draft.approvalSteps], target = index + offset;
    [steps[index], steps[target]] = [steps[target], steps[index]];
    update("approvalSteps", steps);
  };
  return <section aria-label="Purchase Request settings" className="space-y-5">
    <div><h2 className="text-xl font-semibold">Purchase Requests</h2><p className="mt-1 max-w-2xl text-sm text-gray-600">Set the financial categories and approval sequence for internal purchases. Every amount is net, excluding VAT.</p></div>
    <AsyncError error={query.error} onRetry={query.retry} label="Could not load Purchase Request settings." />
    {query.loading && <p role="status">Loading approval settings…</p>}
    {draft && <form onSubmit={(event) => { event.preventDefault(); save(); }} className="space-y-5">
      <section className="grid gap-4 rounded-xl border border-gray-200 bg-white p-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm font-medium">Budget currency<select aria-label="Budget currency" className={fieldClass} value={draft.currency} disabled={locked || query.data.currencyLocked === true} onChange={(event) => update("currency", event.target.value)}>{["EUR", "GBP", "USD", "CHF", "CAD", "AUD"].map((currency) => <option key={currency}>{currency}</option>)}</select><span className="block text-xs font-normal text-gray-500">One currency for requests and budgets. {query.data.currencyLocked ? "Currency is locked because a budget or request has already been saved." : "Currency locks when the first budget or request is saved."}</span></label>
        <label className="space-y-1 text-sm font-medium">When the budget is insufficient<select aria-label="Budget overspend policy" value={draft.overBudgetMode} disabled={locked} onChange={(event) => update("overBudgetMode", event.target.value)} className={fieldClass}><option value="block">Block submission</option><option value="approval">Require additional budget authority</option></select><span className="block text-xs font-normal text-gray-500">Missing allocations always require a budget to be configured first. A zero allocation is an explicit budget.</span></label>
      </section>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <NamedList title="Cost centres" singular="Cost centre" description="The department or accounting centre responsible for the purchase. Separate from the type of cost." items={draft.costCentres} setItems={(items) => update("costCentres", items)} disabled={locked} />
        <NamedList title="Budget categories" singular="Budget category" description="What the purchase is charged to, such as Chinaware or Maintenance. Budgets apply per category and month." items={draft.budgetCategories} setItems={(items) => update("budgetCategories", items)} disabled={locked} />
      </div>
      <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-4">
        <div><h3 className="font-semibold">Required approval sequence</h3><p className="mt-1 text-sm text-gray-600">Steps run from top to bottom. A step applies when the request total reaches its threshold. Use 0.00 to require a step for every request. Intermediate approval keeps the amount pending.</p></div>
        {!draft.approvalSteps.length && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Add at least one approval step and an eligible approver before users can submit requests.</p>}
        {draft.approvalSteps.map((step, index) => <div key={step.id} className="space-y-3 rounded-lg bg-gray-50 p-3">
          <div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold uppercase text-gray-500">Step {index + 1}</span><div className="flex gap-1">
            <button type="button" className="min-h-[40px] rounded p-2 hover:bg-gray-200 disabled:opacity-30" disabled={locked || index === 0} aria-label={`Move step ${index + 1} up`} onClick={() => moveStep(index, -1)}><ArrowUp className="h-4 w-4" aria-hidden="true" /></button>
            <button type="button" className="min-h-[40px] rounded p-2 hover:bg-gray-200 disabled:opacity-30" disabled={locked || index === draft.approvalSteps.length - 1} aria-label={`Move step ${index + 1} down`} onClick={() => moveStep(index, 1)}><ArrowDown className="h-4 w-4" aria-hidden="true" /></button>
            <button type="button" className="min-h-[40px] rounded p-2 text-gray-500 hover:bg-red-50 hover:text-red-700 disabled:opacity-30" disabled={locked} aria-label={`Remove step ${index + 1}`} onClick={() => { update("approvalSteps", draft.approvalSteps.filter((entry) => entry.id !== step.id)); setDraft((previous) => ({ ...previous, approvers: previous.approvers.map((person) => ({ ...person, stepIds: person.stepIds.filter((id) => id !== step.id) })) })); }}><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
          </div></div>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
            <label className="text-sm font-medium">Step name<input aria-label={`Step ${index + 1} name`} className={fieldClass} required maxLength={100} value={step.name} disabled={locked} onChange={(event) => update("approvalSteps", draft.approvalSteps.map((entry) => entry.id === step.id ? { ...entry, name: event.target.value } : entry))} /></label>
            <label className="text-sm font-medium">Required from ({draft.currency}, net)<input aria-label={`Step ${index + 1} threshold`} className={fieldClass} type="text" inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,2})?" required value={step.threshold} disabled={locked} onChange={(event) => update("approvalSteps", draft.approvalSteps.map((entry) => entry.id === step.id ? { ...entry, threshold: event.target.value } : entry))} /></label>
          </div>
        </div>)}
        <button type="button" className="ht-button-secondary" disabled={locked || draft.approvalSteps.length >= 8} onClick={() => update("approvalSteps", [...draft.approvalSteps, { id: newId(), name: "", threshold: "0.00" }])}>Add approval step</button>
      </section>
      <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-4">
        <div><h3 className="font-semibold">Approval authorities</h3><p className="mt-1 text-sm text-gray-600">Only hotel members with Purchase Requests approval permission can be selected. Each approver needs authority for the current step and a limit covering the entire request. Self-approval is never allowed.</p></div>
        {draft.approvers.map((person, index) => <div key={person.uid} className="space-y-3 rounded-lg bg-gray-50 p-3">
          <div className="flex items-center justify-between gap-3"><h4 className="font-medium">{personLabel(person.uid)}</h4><button type="button" className="min-h-[40px] rounded p-2 text-gray-500 hover:bg-red-50" disabled={locked} aria-label={`Remove approver ${index + 1}`} onClick={() => update("approvers", draft.approvers.filter((entry) => entry.uid !== person.uid))}><Trash2 className="h-4 w-4" aria-hidden="true" /></button></div>
          <label className="block max-w-xs text-sm font-medium">Request limit ({draft.currency}, net)<input aria-label={`Approver ${index + 1} limit`} className={fieldClass} inputMode="decimal" type="text" pattern="[0-9]+(\.[0-9]{1,2})?" required value={person.limit} disabled={locked} onChange={(event) => update("approvers", draft.approvers.map((entry) => entry.uid === person.uid ? { ...entry, limit: event.target.value } : entry))} /></label>
          <fieldset disabled={locked} className="flex flex-wrap gap-x-5 gap-y-2"><legend className="mb-2 text-xs font-semibold text-gray-600">Authorized steps</legend>{draft.approvalSteps.map((step, stepIndex) => <label key={step.id} className="flex items-start gap-2 text-sm"><input type="checkbox" aria-label={`${personLabel(person.uid)} — ${step.name || `Step ${stepIndex + 1}`}`} checked={person.stepIds.includes(step.id)} onChange={(event) => update("approvers", draft.approvers.map((entry) => entry.uid === person.uid ? { ...entry, stepIds: event.target.checked ? [...entry.stepIds, step.id] : entry.stepIds.filter((id) => id !== step.id) } : entry))} />{step.name || `Step ${stepIndex + 1}`}</label>)}</fieldset>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" disabled={locked} checked={person.canApproveOverBudget === true} onChange={(event) => update("approvers", draft.approvers.map((entry) => entry.uid === person.uid ? { ...entry, canApproveOverBudget: event.target.checked } : entry))} />May give the additional approval for an over-budget request</label>
        </div>)}
        <label className="block max-w-lg text-sm font-medium">Add eligible approver<select aria-label="Add eligible approver" value="" disabled={locked || !availableUsers.length} onChange={(event) => { if (event.target.value) update("approvers", [...draft.approvers, { uid: event.target.value, stepIds: [], limit: "0.00", canApproveOverBudget: false }]); }} className={fieldClass}><option value="">{availableUsers.length ? "Choose a hotel member" : "No additional eligible members"}</option>{availableUsers.map((person) => <option key={person.uid} value={person.uid}>{personLabel(person.uid)}</option>)}</select></label>
      </section>
      <div className="flex flex-wrap items-center gap-3"><button type="submit" className="ht-button-primary" disabled={locked}>{busy ? "Saving…" : "Save Purchase Request settings"}</button><Link to="/purchase-budgets" className="text-sm font-medium text-brand-800 underline">Open annual budgets</Link></div>
      <p className="text-xs text-gray-500">Names can change while historical requests keep their approved snapshots. Cost centres and categories already used by requests cannot be removed.</p>
    </form>}
    {pending && <div role="status" className="space-y-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900"><p>A previous settings save needs verification. Verify its original values before making another change.</p><button type="button" className="ht-button-secondary" disabled={busy || query.loading || !query.data} onClick={() => save(true)}>Verify original settings save</button></div>}
    <AsyncError error={error} label="Could not save Purchase Request settings." />
    {error && !pending && <button type="button" className="ht-button-secondary" disabled={busy || query.loading} onClick={() => { setError(null); query.retry(); }}>Reload current settings</button>}
    {notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}
  </section>;
}
