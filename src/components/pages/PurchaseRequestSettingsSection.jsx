import React, { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { useProcurementSettingsScope } from "../../hooks/useProcurementSettingsScope";
import { usePermission } from "../../hooks/usePermission";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { getPurchaseRequestSettings, savePurchaseRequestSettings, getPendingPurchaseRequestCommand, retryPurchaseRequestCommand } from "../../services/firebasePurchaseRequests";
import { purchaseMinorToInput, purchaseMoneyToMinor } from "../../utils/purchaseBudgetDraft";
import { purchaseApprovalWarnings } from "../../utils/purchaseApprovalSettings";
import AsyncError from "../shared/AsyncError";

const defaultSettings = { currency: "EUR", costCentres: [], budgetCategories: [], approvalSteps: [], approvers: [], overBudgetMode: "block" };
const fieldClass = "ht-field w-full";
const newId = () => crypto.randomUUID();
function toDraft(settings) {
  return { ...defaultSettings, ...settings,
    approvalSteps: (settings?.approvalSteps || []).map((step) => ({ ...step, threshold: purchaseMinorToInput(step.thresholdMinor || 0) })),
    approvers: (settings?.approvers || []).map((person) => ({ ...person, limit: purchaseMinorToInput(person.limitMinor || 0), selfApprovalEnabled: person.selfApprovalLimitMinor != null, selfLimit: purchaseMinorToInput(person.selfApprovalLimitMinor || 0) })),
  };
}
function toSettings(draft) {
  return { currency: draft.currency, overBudgetMode: draft.overBudgetMode,
    costCentres: draft.costCentres.map(({ id, name, approverUids, substituteUids }) => ({ id, name: name.trim(), ...(approverUids ? { approverUids } : {}), ...(substituteUids ? { substituteUids } : {}) })),
    budgetCategories: draft.budgetCategories.map(({ id, name }) => ({ id, name: name.trim() })),
    approvalSteps: draft.approvalSteps.map(({ id, name, threshold, substituteUids, fallbackStepId, independentRequired }) => ({ id, name: name.trim(), thresholdMinor: purchaseMoneyToMinor(threshold), ...(substituteUids ? { substituteUids } : {}), ...(fallbackStepId !== undefined ? { fallbackStepId } : {}), ...(independentRequired !== undefined ? { independentRequired } : {}) })),
    approvers: draft.approvers.map(({ uid, stepIds, limit, canApproveOverBudget, selfApprovalEnabled, selfLimit, selfApprovalLimitMinor }) => ({ uid, stepIds, limitMinor: purchaseMoneyToMinor(limit), canApproveOverBudget: canApproveOverBudget === true, ...(selfApprovalEnabled ? { selfApprovalLimitMinor: purchaseMoneyToMinor(selfLimit) } : selfApprovalLimitMinor !== undefined ? { selfApprovalLimitMinor: null } : {}) })),
  };
}

export default function PurchaseRequestSettingsSection() {
  const scope = useProcurementSettingsScope();
  const allowed = usePermission("purchasebudgets", "settings");
  return allowed ? <ScopedPurchaseRequestSettings key={scope.scopeKey} scope={scope} /> : null;
}

function NamedList({ title, description, items, setItems, disabled, singular, newItem = {} }) {
  return <section className="space-y-3 rounded-xl border border-gray-200 p-4">
    <div><h3 className="font-semibold">{title}</h3><p className="mt-1 text-sm text-gray-600">{description}</p></div>
    {items.map((item, index) => <div key={item.id} className="flex items-center gap-2">
      <label className="min-w-0 flex-1"><span className="sr-only">{singular} {index + 1} name</span><input aria-label={`${singular} ${index + 1} name`} required maxLength={100} value={item.name} disabled={disabled}
        onChange={(event) => setItems(items.map((entry) => entry.id === item.id ? { ...entry, name: event.target.value } : entry))} className={fieldClass} /></label>
      <button type="button" aria-label={`Remove ${singular.toLowerCase()} ${index + 1}`} disabled={disabled} onClick={() => setItems(items.filter((entry) => entry.id !== item.id))} className="min-h-[44px] rounded-lg p-2 text-gray-500 hover:bg-red-50 hover:text-red-700 disabled:opacity-50"><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
    </div>)}
    {!items.length && <p className="text-sm text-gray-500">No {title.toLowerCase()} configured.</p>}
    <button type="button" className="ht-button-secondary inline-flex items-center gap-2" disabled={disabled || items.length >= 100} onClick={() => setItems([...items, { id: newId(), name: "", ...newItem }])}><Plus className="h-4 w-4" aria-hidden="true" />Add {singular.toLowerCase()}</button>
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
  const availableUsers = userOptions.filter((person) => (person.eligible !== false || person.selfApprovalEligible) && !draft?.approvers.some((entry) => entry.uid === person.uid));
  const personLabel = (uid) => {
    const user = userOptions.find((person) => person.uid === uid) || query.data?.approvers?.find((person) => person.uid === uid);
    return user ? user.displayName || user.name || user.email || uid : `${uid} (review access)`;
  };
  const warnings = draft ? purchaseApprovalWarnings(draft, userOptions) : [];
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
        <NamedList newItem={{ approverUids: [], substituteUids: [] }} title="Cost centres" singular="Cost centre" description="The department or accounting centre responsible for the purchase. Separate from the type of cost." items={draft.costCentres} setItems={(items) => update("costCentres", items)} disabled={locked} />
        <NamedList title="Budget categories" singular="Budget category" description="What the purchase is charged to, such as Chinaware or Maintenance. Budgets apply per category and month." items={draft.budgetCategories} setItems={(items) => update("budgetCategories", items)} disabled={locked} />
      </div>
      <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-4">
        <div><h3 className="font-semibold">Required approval sequence</h3><p className="mt-1 text-sm text-gray-600">Steps run from top to bottom. Required from is the minimum request total that activates a control. Set the first step to 0.00 for department approval on every request. Request limit is the maximum full request total a person may approve. Example: Finance Required from 1,000.00 and a person’s Request limit 5,000.00 allows that person to review Finance requests from 1,000.00 through 5,000.00.</p><p className="mt-2 text-sm text-gray-600">If the requester is the only eligible approver for the first required step, approval starts at the immediately next configured step, even below its threshold. That step needs an independent eligible approver with a limit covering the full request. The full remaining route must be possible with different people. Designated substitutes or a configured higher level perform the original control; they do not remove other required controls. Additional budget approval remains separate.</p></div>
        {!draft.approvalSteps.length && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Add at least one approval step and an eligible approver before users can submit requests.</p>}
        {draft.approvalSteps.map((step, index) => <div key={step.id} className="space-y-3 rounded-lg bg-gray-50 p-3">
          <div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold uppercase text-gray-500">Step {index + 1}</span><div className="flex gap-1">
            <button type="button" className="min-h-[40px] rounded p-2 hover:bg-gray-200 disabled:opacity-30" disabled={locked || index === 0} aria-label={`Move step ${index + 1} up`} onClick={() => moveStep(index, -1)}><ArrowUp className="h-4 w-4" aria-hidden="true" /></button>
            <button type="button" className="min-h-[40px] rounded p-2 hover:bg-gray-200 disabled:opacity-30" disabled={locked || index === draft.approvalSteps.length - 1} aria-label={`Move step ${index + 1} down`} onClick={() => moveStep(index, 1)}><ArrowDown className="h-4 w-4" aria-hidden="true" /></button>
            <button type="button" className="min-h-[40px] rounded p-2 text-gray-500 hover:bg-red-50 hover:text-red-700 disabled:opacity-30" disabled={locked} aria-label={`Remove step ${index + 1}`} onClick={() => { update("approvalSteps", draft.approvalSteps.filter((entry) => entry.id !== step.id).map((entry) => entry.fallbackStepId === step.id ? { ...entry, fallbackStepId: "" } : entry)); setDraft((previous) => ({ ...previous, approvers: previous.approvers.map((person) => ({ ...person, stepIds: person.stepIds.filter((id) => id !== step.id) })) })); }}><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
          </div></div>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
            <label className="text-sm font-medium">Step name<input aria-label={`Step ${index + 1} name`} className={fieldClass} required maxLength={100} value={step.name} disabled={locked} onChange={(event) => update("approvalSteps", draft.approvalSteps.map((entry) => entry.id === step.id ? { ...entry, name: event.target.value } : entry))} /></label>
            <label className="text-sm font-medium">Required from ({draft.currency}, net)<input aria-label={`Step ${index + 1} threshold`} className={fieldClass} type="text" inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,2})?" required value={step.threshold} disabled={locked} onChange={(event) => update("approvalSteps", draft.approvalSteps.map((entry) => entry.id === step.id ? { ...entry, threshold: event.target.value } : entry))} /></label>
          </div>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" disabled={locked} checked={step.independentRequired === true} onChange={(event) => update("approvalSteps", draft.approvalSteps.map((entry) => entry.id === step.id ? { ...entry, independentRequired: event.target.checked } : entry))} />Always require an independent person, including after direct self-approval</label>
          <details className="text-sm"><summary className="min-h-[40px] cursor-pointer py-2 font-medium">Substitutes and higher approval level</summary>
            <p className="mb-3 text-xs text-gray-600">These designated alternatives may perform this control. Every person still needs Approve permission and a Request limit covering the full amount.</p>
            <AuthorityChoices label={`Step ${index + 1} substitutes`} people={draft.approvers} selected={step.substituteUids || []} personLabel={personLabel} disabled={locked} onChange={(uids) => update("approvalSteps", draft.approvalSteps.map((entry) => entry.id === step.id ? { ...entry, substituteUids: uids } : entry))} />
            <label className="mt-3 block">Higher approval level<select aria-label={`Step ${index + 1} higher approval level`} className={fieldClass} disabled={locked} value={step.fallbackStepId || ""} onChange={(event) => update("approvalSteps", draft.approvalSteps.map((entry) => entry.id === step.id ? { ...entry, fallbackStepId: event.target.value } : entry))}><option value="">No higher-level replacement</option>{draft.approvalSteps.slice(index + 1).map((entry) => <option key={entry.id} value={entry.id}>{entry.name || "Unnamed step"}</option>)}</select></label>
          </details>
        </div>)}
        <button type="button" className="ht-button-secondary" disabled={locked || draft.approvalSteps.length >= 8} onClick={() => update("approvalSteps", [...draft.approvalSteps, { id: newId(), name: "", threshold: "0.00" }])}>Add approval step</button>
      </section>
      <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-4">
        <div><h3 className="font-semibold">Approval authorities</h3><p className="mt-1 text-sm text-gray-600">Choose hotel members with Purchase Requests Approve or Self-approve permission. Each approver needs authority for the current step and a limit covering the entire request. Standard approvals exclude the requester and anyone who already approved. Direct self-approval requires the separate Self-approve permission and a self-approval limit. Independent controls always require another person.</p></div>
        {draft.approvers.map((person, index) => <div key={person.uid} className="space-y-3 rounded-lg bg-gray-50 p-3">
          <div className="flex items-center justify-between gap-3"><h4 className="font-medium">{personLabel(person.uid)}</h4><button type="button" className="min-h-[40px] rounded p-2 text-gray-500 hover:bg-red-50" disabled={locked} aria-label={`Remove approver ${index + 1}`} onClick={() => setDraft((previous) => ({ ...previous, approvers: previous.approvers.filter((entry) => entry.uid !== person.uid), costCentres: previous.costCentres.map((row) => ({ ...row, ...(row.approverUids ? { approverUids: row.approverUids.filter((uid) => uid !== person.uid) } : {}), ...(row.substituteUids ? { substituteUids: row.substituteUids.filter((uid) => uid !== person.uid) } : {}) })), approvalSteps: previous.approvalSteps.map((row) => ({ ...row, ...(row.substituteUids ? { substituteUids: row.substituteUids.filter((uid) => uid !== person.uid) } : {}) })) }))}><Trash2 className="h-4 w-4" aria-hidden="true" /></button></div>
          <label className="block max-w-xs text-sm font-medium">Request limit ({draft.currency}, net)<input aria-label={`Approver ${index + 1} limit`} className={fieldClass} inputMode="decimal" type="text" pattern="[0-9]+(\.[0-9]{1,2})?" required value={person.limit} disabled={locked} onChange={(event) => update("approvers", draft.approvers.map((entry) => entry.uid === person.uid ? { ...entry, limit: event.target.value } : entry))} /></label>
          <fieldset disabled={locked} className="flex flex-wrap gap-x-5 gap-y-2"><legend className="mb-2 text-xs font-semibold text-gray-600">Authorized steps</legend>{draft.approvalSteps.map((step, stepIndex) => <label key={step.id} className="flex items-start gap-2 text-sm"><input type="checkbox" aria-label={`${personLabel(person.uid)} — ${step.name || `Step ${stepIndex + 1}`}`} checked={person.stepIds.includes(step.id)} onChange={(event) => update("approvers", draft.approvers.map((entry) => entry.uid === person.uid ? { ...entry, stepIds: event.target.checked ? [...entry.stepIds, step.id] : entry.stepIds.filter((id) => id !== step.id) } : entry))} />{step.name || `Step ${stepIndex + 1}`}</label>)}</fieldset>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" disabled={locked} checked={person.canApproveOverBudget === true} onChange={(event) => update("approvers", draft.approvers.map((entry) => entry.uid === person.uid ? { ...entry, canApproveOverBudget: event.target.checked } : entry))} />May give the additional approval for an over-budget request</label>
          <div className="rounded-lg border border-violet-200 bg-violet-50/50 p-3">
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" aria-label={`${personLabel(person.uid)} self-approval limit enabled`} disabled={locked} checked={person.selfApprovalEnabled === true} onChange={(event) => update("approvers", draft.approvers.map((entry) => entry.uid === person.uid ? { ...entry, selfApprovalEnabled: event.target.checked } : entry))} />Allow direct self-approval up to a separate limit</label>
            {person.selfApprovalEnabled && <label className="mt-3 block max-w-xs text-sm">Self-approval limit ({draft.currency}, net)<input aria-label={`Approver ${index + 1} self-approval limit`} className={fieldClass} inputMode="decimal" required value={person.selfLimit || "0.00"} disabled={locked} onChange={(event) => update("approvers", draft.approvers.map((entry) => entry.uid === person.uid ? { ...entry, selfLimit: event.target.value } : entry))} /></label>}
            <p className="mt-2 text-xs text-gray-600">Also grant Purchase Requests → Self-approve in user permissions. This limit covers ordinary controls only. Independent and additional budget approval still require other people.</p>
          </div>
        </div>)}
        <label className="block max-w-lg text-sm font-medium">Add eligible approver<select aria-label="Add eligible approver" value="" disabled={locked || !availableUsers.length} onChange={(event) => { if (event.target.value) update("approvers", [...draft.approvers, { uid: event.target.value, stepIds: [], limit: "0.00", canApproveOverBudget: false, selfApprovalEnabled: false, selfLimit: "0.00" }]); }} className={fieldClass}><option value="">{availableUsers.length ? "Choose a hotel member" : "No additional eligible members"}</option>{availableUsers.map((person) => <option key={person.uid} value={person.uid}>{personLabel(person.uid)}</option>)}</select></label>
      </section>
      <section className="space-y-4 rounded-xl border bg-white p-4" aria-label="Department approval assignments"><div><h3 className="font-semibold">Department approval assignments</h3><p className="mt-1 text-sm text-gray-600">The selected cost centre determines who performs the first configured step. Subsequent steps follow the request amount. Designated substitutes may perform the department control within their own Request limit.</p></div>
        {draft.costCentres.map((centre) => <div key={centre.id} className="space-y-3 rounded-lg bg-gray-50 p-3"><h4 className="font-medium">{centre.name || "Unnamed cost centre"}</h4>
          <label className="block text-sm">Department routing<select aria-label={`${centre.name} department routing`} className={fieldClass} disabled={locked} value={Object.hasOwn(centre, "approverUids") ? "department" : "all"} onChange={(event) => update("costCentres", draft.costCentres.map((entry) => { if (entry.id !== centre.id) return entry; if (event.target.value === "department") return { ...entry, approverUids: [], substituteUids: entry.substituteUids || [] }; const { approverUids, substituteUids, ...rest } = entry; return rest; }))}><option value="department">Department-specific approvers</option><option value="all">All first-step approvers</option></select></label>
          {Object.hasOwn(centre, "approverUids") && <><AuthorityChoices label={`${centre.name} department approvers`} people={draft.approvers.filter((person) => person.stepIds.includes(draft.approvalSteps[0]?.id))} selected={centre.approverUids} personLabel={personLabel} disabled={locked} onChange={(uids) => update("costCentres", draft.costCentres.map((entry) => entry.id === centre.id ? { ...entry, approverUids: uids } : entry))} /><AuthorityChoices label={`${centre.name} department substitutes`} people={draft.approvers} selected={centre.substituteUids || []} personLabel={personLabel} disabled={locked} onChange={(uids) => update("costCentres", draft.costCentres.map((entry) => entry.id === centre.id ? { ...entry, substituteUids: uids } : entry))} /></>}
        </div>)}
      </section>
      {warnings.length > 0 && <aside role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"><h3 className="font-semibold">Configuration checks</h3><ul className="mt-2 list-disc space-y-2 pl-5">{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul><p className="mt-3 text-xs">Every submission checks the full route with current accounts, permissions, limits and the actual requester. Saving settings never approves a request.</p></aside>}
      <div className="sticky bottom-3 flex flex-wrap items-center gap-3 rounded-xl border bg-white p-4 shadow-sm"><button type="submit" className="ht-button-primary" disabled={locked}>{busy ? "Saving…" : "Save Purchase Request settings"}</button><Link to="/purchase-budgets" className="text-sm font-medium text-brand-800 underline">Open annual budgets</Link></div>
      <p className="text-xs text-gray-500">Names can change while historical requests keep their approved snapshots. Cost centres and categories already used by requests cannot be removed.</p>
    </form>}
    {pending && <div role="status" className="space-y-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900"><p>A previous settings save needs verification. Verify its original values before making another change.</p><button type="button" className="ht-button-secondary" disabled={busy || query.loading || !query.data} onClick={() => save(true)}>Verify original settings save</button></div>}
    <AsyncError error={error} label="Could not save Purchase Request settings." />
    {error && !pending && <button type="button" className="ht-button-secondary" disabled={busy || query.loading} onClick={() => { setError(null); query.retry(); }}>Reload current settings</button>}
    {notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}
  </section>;
}

function AuthorityChoices({ label, people, selected, personLabel, disabled, onChange }) {
  return <fieldset disabled={disabled} className="space-y-2"><legend className="mb-2 text-xs font-semibold text-gray-600">{label}</legend>{!people.length && <p className="text-xs text-gray-600">Add an approval authority with the appropriate permission first.</p>}<div className="flex flex-wrap gap-x-5 gap-y-2">{people.map((person) => <label key={person.uid} className="flex min-h-[36px] items-center gap-2 text-sm"><input type="checkbox" aria-label={`${label}: ${personLabel(person.uid)}`} checked={selected.includes(person.uid)} onChange={(event) => onChange(event.target.checked ? [...selected, person.uid] : selected.filter((uid) => uid !== person.uid))} />{personLabel(person.uid)}</label>)}</div></fieldset>;
}
