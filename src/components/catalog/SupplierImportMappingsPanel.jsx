import React, { useEffect, useRef, useState } from "react";
import SupplierImportFormatProfile from "./SupplierImportFormatProfile";
import { Combobox } from "../ui/combobox";
import { usePermission } from "../../hooks/usePermission";
import { PURCHASE_UNITS } from "../../utils/supplierImportWorkspace";
import { readSupplierPurchaseUnitMappings, saveSupplierPurchaseUnitMappings, applySupplierImportMapping } from "../../services/firebaseSupplierImportWorkspace";

export default function SupplierImportMappingsPanel({ hotelUid, jobId = null, supplierId, supplierName, sourceFormat, profileId = "default", sourceFormatCandidate = null, sourceInterpretation = null, formatApplication = null, groups = [], truncated = false, locked = false, standalone = false, current = () => true, onApplied, onBusyChange }) {
  const [profile, setProfile] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState(null), [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState({}), [remember, setRemember] = useState({}), [message, setMessage] = useState("");
  const [editingRule, setEditingRule] = useState(null), [editedUnit, setEditedUnit] = useState(null);
  const [newCode, setNewCode] = useState(""), [newUnit, setNewUnit] = useState(null);
  const [readRetry, setReadRetry] = useState(0);
  const alive = useRef(true), pending = useRef(null), pendingRule = useRef(null), latest = useRef({ hotelUid, jobId, supplierId, sourceFormat, profileId });
  latest.current = { hotelUid, jobId, supplierId, sourceFormat, profileId };
  const canCreate = usePermission("supplierproducts", "create"), canUpdate = usePermission("supplierproducts", "update");
  const identity = JSON.stringify([hotelUid, jobId, supplierId, sourceFormat, profileId]);
  const active = (captured = identity) => alive.current && current() && JSON.stringify(Object.values(latest.current)) === captured;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false; setLoading(true); setProfile(null); setError(null); pending.current = null; pendingRule.current = null; setEditingRule(null); setEditedUnit(null); setNewCode(""); setNewUnit(null); setChoices({}); setRemember({}); setMessage("");
    if (!sourceFormat) { setLoading(false); return () => { cancelled = true; }; }
    readSupplierPurchaseUnitMappings(hotelUid, supplierId, sourceFormat, profileId).then((value) => { if (!cancelled && active()) setProfile(value); }).catch((failure) => { if (!cancelled && active()) setError(failure); }).finally(() => { if (!cancelled && active()) setLoading(false); });
    return () => { cancelled = true; };
  }, [hotelUid, supplierId, sourceFormat, profileId, readRetry]);
  const unresolved = groups.filter((group) => group.status !== "mapped");
  const waiting = Boolean(pending.current || pendingRule.current);
  const formatPending = Boolean(formatApplication && !formatApplication.complete);
  const controlsLocked = locked || busy || waiting || formatPending;
  const sameCode = (left, right) => left.normalize("NFKC").trim().toUpperCase() === right.normalize("NFKC").trim().toUpperCase();
  const canRetryRule = canCreate && (canUpdate || !profile?.mappings.some((entry) => pendingRule.current
    && sameCode(entry.sourceUnit, pendingRule.current.sourceUnit) && entry.purchaseUnit !== pendingRule.current.purchaseUnit));
  const saveRule = async (newMapping = false) => {
    if (!active() || formatPending || locked || busy || pending.current || !canCreate || !profile) return;
    const operation = pendingRule.current || { sourceUnit: newMapping === true ? newCode.normalize("NFC").trim().toUpperCase() : editingRule,
      purchaseUnit: newMapping === true ? newUnit : editedUnit, expectedRevision: profile.revision, identity };
    if (!operation.sourceUnit || !PURCHASE_UNITS.includes(operation.purchaseUnit)) return;
    if (profile.mappings.some((entry) => sameCode(entry.sourceUnit, operation.sourceUnit) && entry.purchaseUnit !== operation.purchaseUnit) && !canUpdate) return;
    pendingRule.current = operation;
    setBusy(true); onBusyChange?.(true); setError(null); setMessage("");
    try {
      const saved = await saveSupplierPurchaseUnitMappings(hotelUid, supplierId, sourceFormat, profileId, operation.expectedRevision, [{ sourceUnit: operation.sourceUnit, purchaseUnit: operation.purchaseUnit }]);
      if (!active(operation.identity)) return;
      pendingRule.current = null; setProfile(saved); setEditingRule(null); setEditedUnit(null); setNewCode(""); setNewUnit(null);
      setMessage(`${operation.sourceUnit} → ${operation.purchaseUnit} saved for future ${sourceFormat.toUpperCase()} imports using profile ${profileId} (revision ${saved.revision}). ${standalone ? "New imports will use this rule. Existing reviews and imported products are unchanged." : "This draft, imported products and historical records are unchanged. Apply the saved rule to this draft separately if needed."}`);
    } catch (failure) {
      if (active(operation.identity)) {
        setError(failure);
        if (["invalid-argument", "permission-denied", "unauthenticated", "not-found", "failed-precondition", "already-exists", "aborted"].includes(String(failure.code || "").replace(/^functions\//, ""))) {
          pendingRule.current = null;
          if (String(failure.code || "").replace(/^functions\//, "") === "aborted") {
            try { const refreshed = await readSupplierPurchaseUnitMappings(hotelUid, supplierId, sourceFormat, profileId); if (active(operation.identity)) setProfile(refreshed); }
            catch (refreshFailure) { if (active(operation.identity)) { setProfile(null); setError(refreshFailure); } }
          }
        }
      }
    } finally { if (active(operation.identity)) { setBusy(false); onBusyChange?.(false); } }
  };
  const apply = async (group, savedRule = null) => {
    if (!active() || formatPending || locked || busy || pendingRule.current || (!canCreate && !canUpdate)) return;
    let operation = pending.current;
    if (!operation) {
      const purchaseUnit = savedRule?.purchaseUnit || choices[group.sourceUnit] || group.suggestedUnit;
      if (!PURCHASE_UNITS.includes(purchaseUnit) || !sourceFormat || !group.rowIds.length) return;
      const save = !savedRule && remember[group.sourceUnit] === true;
      if (save && !profile) return;
      operation = { group, purchaseUnit, save, identity, rows: group.rowIds, offset: 0, revision: savedRule?.revision ?? null, saved: false, savedRule: Boolean(savedRule), outcomes: [] };
      pending.current = operation;
    }
    setBusy(true); onBusyChange?.(true); setError(null); setMessage("");
    try {
      if (operation.save && !operation.saved) {
        const saved = await saveSupplierPurchaseUnitMappings(hotelUid, supplierId, sourceFormat, profileId, profile.revision, [{ sourceUnit: operation.group.sourceUnit, purchaseUnit: operation.purchaseUnit }]);
        if (!active(operation.identity)) return;
        operation.revision = saved.revision; operation.saved = true; setProfile(saved);
      }
      while (operation.offset < operation.rows.length) {
        if (!active(operation.identity)) return;
        const result = await applySupplierImportMapping(hotelUid, jobId, { sourceUnit: operation.group.sourceUnit, purchaseUnit: operation.purchaseUnit, expectedMappingRevision: operation.revision, rows: operation.rows.slice(operation.offset, operation.offset + 25) });
        if (!active(operation.identity)) return;
        operation.outcomes.push(...result.outcomes);
        operation.offset += 25;
      }
      if (!active(operation.identity)) return;
      pending.current = null;
      const mapped = operation.outcomes.filter((outcome) => outcome.status === "mapped").length, skipped = operation.outcomes.filter((outcome) => outcome.status === "skipped").length, blocked = operation.outcomes.filter((outcome) => outcome.status === "blocked").length;
      setMessage(`${operation.group.sourceUnit} → ${operation.purchaseUnit}: ${mapped} draft products updated, ${skipped} preserved, ${blocked} need individual review.${operation.saved ? " The supplier rule was saved for future imports of this format." : operation.savedRule ? " The saved supplier rule was explicitly applied to this draft." : " This choice applies to this import only."} Human corrections, skipped products and already imported products are preserved. Review updated products before approving them.`);
      await onApplied?.();
    } catch (failure) {
      if (active(operation.identity)) {
        setError(failure);
        // A terminal validation response establishes that no ambiguous command
        // is left to replay. Refresh revisions before trying a new selection.
        if (["invalid-argument", "permission-denied", "not-found", "failed-precondition", "already-exists", "aborted"].includes(String(failure.code || "").replace(/^functions\//, ""))) {
          pending.current = null;
          const mapped = operation.outcomes.filter((outcome) => outcome.status === "mapped").length;
          if (mapped) setMessage(`${mapped} draft products were updated before this conflict. Those changes are preserved. Review the refreshed remaining products and supplier rule before confirming a new selection.`);
          if (String(failure.code || "").replace(/^functions\//, "") === "aborted") {
            try { const refreshed = await readSupplierPurchaseUnitMappings(hotelUid, supplierId, sourceFormat, profileId); if (active(operation.identity)) setProfile(refreshed); }
            catch (refreshFailure) { if (active(operation.identity)) { setProfile(null); setError(refreshFailure); } }
          }
          try { await onApplied?.(); } catch (refreshFailure) { if (active(operation.identity)) setError(refreshFailure); }
        }
      }
    } finally { if (active(operation.identity)) { setBusy(false); onBusyChange?.(false); } }
  };
  if (!sourceFormat || (!standalone && !unresolved.length && !profile?.mappings?.length && !profile?.interpretation && !sourceFormatCandidate && !loading)) return null;
  return <section aria-label="Supplier purchase-unit mappings" className="space-y-4 rounded-2xl border border-stone-200 bg-white p-4 sm:p-5">
    <div><h2 className="font-semibold text-brand-950">Supplier import profile</h2><p className="mt-1 text-sm text-stone-600">{standalone ? "Manage the supplier's package codes for future imports of this file format. " : "Confirm abbreviations once for the affected products. "}Saving a supplier rule also reuses it in future {sourceFormat?.toUpperCase()} imports with this profile. A package label does not establish its physical contents or approve any product.</p></div>
    {loading && <p role="status" className="animate-pulse text-sm text-stone-500">Checking saved supplier mappings…</p>}
    {error && !profile && !pending.current && !pendingRule.current && <button type="button" className="ht-button-secondary" disabled={locked || busy} onClick={() => setReadRetry((value) => value + 1)}>Retry mapping profile</button>}
    {standalone && profile && <div className="space-y-3 rounded-xl border border-stone-200 bg-stone-50 p-4">
      {!profile.mappings.length && <p className="text-sm text-stone-600">No saved mappings for this supplier and file format.</p>}
      <h3 className="text-sm font-semibold">Add a supplier mapping</h3>
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs font-semibold">Source package code<input aria-label="Source package code" maxLength={80} value={newCode} disabled={controlsLocked || !canCreate} onChange={(event) => setNewCode(event.target.value)} className="ht-field mt-1 w-full" placeholder="For example, BK" /></label>
        <label className="text-xs font-semibold">English purchase unit<Combobox aria-label="New mapping purchase unit" value={newUnit} options={PURCHASE_UNITS} displayValue={(unit) => unit} getOptionValue={(unit) => unit} onChange={setNewUnit} disabled={controlsLocked || !canCreate} placeholder="Select purchase unit" /></label></div>
      {profile.mappings.some((entry) => sameCode(entry.sourceUnit, newCode)) && <p className="text-xs text-amber-900">This code already has a rule. Saving a different label replaces it for future imports and requires update permission.</p>}
      {profile.suggestions.length > 0 && <div><p className="mb-2 text-xs text-stone-500">Suggestions require your confirmation.</p><div className="flex flex-wrap gap-2">{profile.suggestions.map((entry) => <button key={entry.sourceUnit} type="button" className="rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs text-stone-700" disabled={controlsLocked || !canCreate} onClick={() => { setNewCode(entry.sourceUnit); setNewUnit(entry.purchaseUnit); }}>Use {entry.sourceUnit} → {entry.purchaseUnit}</button>)}</div></div>}
      <button type="button" className="ht-button-primary" disabled={controlsLocked || !canCreate || !newCode.trim() || /[\u0000-\u001f\u007f/\\]/.test(newCode) || !newUnit || (!canUpdate && profile.mappings.some((entry) => sameCode(entry.sourceUnit, newCode) && entry.purchaseUnit !== newUnit))} onClick={() => saveRule(true)}>Save mapping for future imports</button>
      {!canCreate && <p className="text-xs text-stone-500">Supplier-product create permission is required to save mapping rules.</p>}
    </div>}
    <SupplierImportFormatProfile key={identity} hotelUid={hotelUid} supplierId={supplierId} sourceFormat={sourceFormat} profileId={profileId} jobId={jobId} profile={profile} candidate={sourceFormatCandidate} interpretation={sourceInterpretation} formatApplication={formatApplication} canCreate={canCreate} canUpdate={canUpdate} locked={locked || busy || waiting} current={() => active()} onSaved={setProfile} onApplied={onApplied} onBusyChange={(value) => { setBusy(value); onBusyChange?.(value); }} />
    {truncated && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">There are more purchase-unit codes than this overview can display. Review the remaining products individually.</p>}
    <div className="space-y-3">{unresolved.map((group) => {
      const chosen = choices[group.sourceUnit] || group.suggestedUnit || null;
      const established = profile?.mappings?.find((entry) => entry.sourceUnit === group.sourceUnit);
      const maySave = canCreate && (!established || canUpdate);
      return <div key={group.sourceUnit} className="rounded-xl border border-stone-200 bg-stone-50 p-3 sm:p-4">
        <div className="grid min-w-0 items-start gap-3 md:grid-cols-[1fr_1fr_auto]"><div><p className="font-semibold">{group.sourceUnit} <span className="ml-1 text-xs font-normal text-stone-500">{group.count} {group.count === 1 ? "product" : "products"}</span></p><p className="mt-1 text-xs text-stone-600">{group.status === "conflict" ? "The saved mapping conflicts with this source. Confirm the intended package." : group.suggestedUnit ? `Suggested: ${group.suggestedUnit}. Confirm against the document.` : "No reliable mapping is available. Choose the English package name."}</p></div>
          <label className="min-w-0 text-xs font-semibold">English purchase unit<Combobox aria-label={`Purchase unit for ${group.sourceUnit}`} value={chosen} options={PURCHASE_UNITS} displayValue={(unit) => unit} getOptionValue={(unit) => unit} onChange={(unit) => setChoices((previous) => ({ ...previous, [group.sourceUnit]: unit }))} disabled={controlsLocked} placeholder="Select purchase unit" /></label>
          <button type="button" className="ht-button-secondary md:mt-5" disabled={controlsLocked || !chosen || !group.rowIds.length || (!canCreate && !canUpdate) || (remember[group.sourceUnit] && !profile)} onClick={() => apply(group)}>{busy && pending.current?.group.sourceUnit === group.sourceUnit ? "Applying mapping…" : "Confirm & apply"}</button>
        </div>
        <label className="mt-3 flex items-start gap-2 text-sm text-stone-700"><input type="checkbox" className="mt-1" checked={remember[group.sourceUnit] === true} disabled={controlsLocked || !profile || !maySave} onChange={(event) => setRemember((previous) => ({ ...previous, [group.sourceUnit]: event.target.checked }))} /><span>Save this mapping for this supplier and file format{established && <span className="block text-xs text-amber-900">Current rule: {group.sourceUnit} → {established.purchaseUnit}. Saving replaces this supplier rule.</span>}</span></label>
      </div>;
    })}</div>
    {profile?.mappings?.length > 0 && <details className="text-sm"><summary className="cursor-pointer font-medium text-stone-600">Saved mappings ({profile.mappings.length})</summary>
      <p className="mt-3 text-xs text-stone-500">Supplier {supplierName || supplierId} · {sourceFormat.toUpperCase()} · Revision {profile.revision}{profileId !== "default" && ` · Profile ${profileId}`}. {standalone ? "Rule edits affect new imports. Existing reviews keep their original snapshot." : "Rule edits affect future imports; this draft changes only after a separate explicit application."}</p>
      <div className="mt-3 space-y-3">{profile.mappings.map((mapping) => {
        const group = groups.find((entry) => sameCode(entry.sourceUnit, mapping.sourceUnit));
        const editing = editingRule === mapping.sourceUnit;
        return <article key={mapping.sourceUnit} className="rounded-xl border border-stone-200 bg-stone-50 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm"><strong>{mapping.sourceUnit}</strong> → {mapping.purchaseUnit}</p><button type="button" className="text-xs font-medium text-brand-800 underline" aria-label={`Edit ${mapping.sourceUnit} rule`} disabled={controlsLocked || !canCreate || !canUpdate} onClick={() => { setEditingRule(mapping.sourceUnit); setEditedUnit(mapping.purchaseUnit); setError(null); }}>Edit rule</button></div>
          {editing && <div className="mt-3 space-y-3 rounded-lg border border-stone-200 bg-white p-3"><label className="block text-xs font-semibold">English purchase unit<Combobox aria-label={`Saved purchase unit for ${mapping.sourceUnit}`} value={editedUnit} options={PURCHASE_UNITS} displayValue={(unit) => unit} getOptionValue={(unit) => unit} onChange={setEditedUnit} disabled={controlsLocked || !canCreate || !canUpdate} /></label><p className="text-xs text-stone-600">Replace {mapping.sourceUnit} → {mapping.purchaseUnit} for future imports of this supplier, file format and profile. Existing imports retain their original mapping snapshot.</p><div className="flex flex-wrap gap-2"><button type="button" className="ht-button-secondary" disabled={controlsLocked || !canCreate || !canUpdate || !editedUnit || editedUnit === mapping.purchaseUnit} onClick={saveRule}>Save for future imports</button><button type="button" className="text-xs text-stone-600 underline" disabled={controlsLocked} onClick={() => { setEditingRule(null); setEditedUnit(null); }}>Cancel rule edit</button></div></div>}
          {group?.rowIds?.length > 0 && <div className="mt-3 border-t border-stone-200 pt-3"><p className="mb-2 text-xs text-stone-600">{group.count} draft products can be checked against this saved rule. Human corrections, skipped products and imported products are preserved.</p><button type="button" className="ht-button-secondary text-xs" aria-label={`Apply ${mapping.sourceUnit} rule to this draft`} disabled={controlsLocked || Boolean(editingRule) || (!canCreate && !canUpdate)} onClick={() => apply(group, { purchaseUnit: mapping.purchaseUnit, revision: profile.revision })}>Apply saved rule to this draft</button></div>}
        </article>;
      })}</div>
      {!canUpdate && <p className="mt-3 text-xs text-stone-500">Supplier-product update permission is required to replace a saved rule.</p>}
    </details>}
    {message && <p role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-900">{message}</p>}
    {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800"><p>{error.message}</p>{pending.current && <button type="button" className="mt-2 underline" disabled={locked || busy} onClick={() => apply(pending.current.group)}>Retry the same mapping</button>}{pendingRule.current && <button type="button" className="mt-2 underline" disabled={locked || busy || !canRetryRule} onClick={saveRule}>Retry the same rule save</button>}</div>}
  </section>;
}
