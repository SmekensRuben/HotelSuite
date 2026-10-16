import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Paperclip, Plus } from "lucide-react";
import PageShell from "../layout/PageShell";
import { auth } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { usePermission } from "../../hooks/usePermission";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { getPurchaseRequest, getPurchaseRequestContext, getPendingPurchaseRequestCommand, mutatePurchaseRequest, retryPurchaseRequestCommand } from "../../services/firebasePurchaseRequests";
import { uploadPurchaseRequestAttachment, PURCHASE_REQUEST_ATTACHMENT_ACCEPT } from "../../services/firebasePurchaseRequestAttachments";
import { requestLineTotalMinor, requestBudgetImpact, purchaseRequestMoney } from "../../utils/purchaseRequests";
import { requestFieldClass as field, RequestBudgetSummary, RequestError, RequestRecovery } from "../purchasing/PurchaseRequestShared";
import PurchaseRequestLineEditor from "../purchasing/PurchaseRequestLineEditor";

const newLine = () => ({ id: crypto.randomUUID(), kind: "free", supplierId: "", description: "", quantity: "1", unitPrice: "", unit: "each" });
const emptyDraft = () => ({ title: "", description: "", motivation: "", costCentreId: "", budgetCategoryId: "", budgetMonth: "", lines: [newLine()], attachmentIds: [] });
const draftFromRequest = (request) => ({ title: request.title || "", description: request.description || "", motivation: request.motivation || "", costCentreId: request.costCentreId || "", budgetCategoryId: request.budgetCategoryId || "", budgetMonth: request.budgetMonth || "", lines: (request.lines || []).map((line) => {
  const ownSupplier = Object.prototype.hasOwnProperty.call(line, "supplierId");
  return { id: line.id, kind: line.kind, supplierId: (ownSupplier ? line.supplierId : request.supplierId) || "", supplierName: line.supplier?.name || (!ownSupplier ? request.supplier?.name : "") || "", description: line.description || line.supplierProductName || "", quantity: String(line.quantity), unitPrice: line.unitPrice == null ? "" : String(line.unitPrice), unit: line.unit || "each", ...(line.supplierProductId ? { supplierProductId: line.supplierProductId, ...(line.purchaseOptionId ? { purchaseOptionId: line.purchaseOptionId } : {}) } : {}) };
}), attachmentIds: [...(request.attachmentIds || [])] });
const inputLine = (line) => ({ id: line.id, kind: line.kind, supplierId: line.supplierId || "", description: line.description, quantity: line.quantity, unitPrice: line.unitPrice, unit: line.unit, ...(line.kind === "supplier" ? { supplierProductId: line.supplierProductId, ...(line.purchaseOptionId ? { purchaseOptionId: line.purchaseOptionId } : {}) } : {}) });

export default function PurchaseRequestFormPage() {
  const { purchaseRequestId } = useParams(), { hotelUid } = useHotelContext();
  const canRead = usePermission("purchaserequests", "read"), canWrite = usePermission("purchaserequests", purchaseRequestId ? "update" : "create");
  return <PageShell variant="procurement" width="workspace" className="max-w-6xl space-y-5"><PurchaseRequestForm key={`${hotelUid}:${auth.currentUser?.uid}:${purchaseRequestId || "new"}:${canRead}:${canWrite}`} hotelUid={hotelUid} purchaseRequestId={purchaseRequestId} canRead={canRead} canWrite={canWrite} /></PageShell>;
}
function PurchaseRequestForm({ hotelUid, purchaseRequestId, canRead, canWrite }) {
  const navigate = useNavigate(), { permissions } = useHotelContext();
  const [draft, setDraft] = useState(emptyDraft), [attachments, setAttachments] = useState([]);
  const [pending, setPending] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const mounted = useRef(true), draftState = useRef(draft);
  const [initialized, setInitialized] = useState(false);
  draftState.current = draft;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const scopeKey = `${hotelUid}:${auth.currentUser?.uid}:${canRead}:${canWrite}:${JSON.stringify(permissions)}`;
  const load = useCallback(async () => {
    const [context, detail] = await Promise.all([getPurchaseRequestContext(hotelUid), purchaseRequestId ? getPurchaseRequest(hotelUid, purchaseRequestId) : Promise.resolve(null)]);
    return { context, detail };
  }, [hotelUid, purchaseRequestId]);
  const { data, loading, error: loadError, retry } = useScopedAsync({ scopeKey, enabled: Boolean(hotelUid && canRead && canWrite), load });
  useEffect(() => {
    if (!data || initialized) return;
    setInitialized(true);
    if (data.detail?.request) { setDraft(draftFromRequest(data.detail.request)); setAttachments(data.detail.request.attachments || []); }
    try { setPending(getPendingPurchaseRequestCommand(hotelUid, purchaseRequestId || "create")); } catch (failure) { setError(failure.message); }
  }, [data, initialized, hotelUid, purchaseRequestId]);
  const previewKey = `${scopeKey}:${draft.budgetMonth}:${draft.budgetCategoryId}`;
  const loadPreview = useCallback(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
    return getPurchaseRequestContext(hotelUid, { budgetMonth: draft.budgetMonth, budgetCategoryId: draft.budgetCategoryId });
  }, [hotelUid, draft.budgetMonth, draft.budgetCategoryId]);
  const { data: preview, loading: previewLoading, error: previewError, retry: retryPreview } = useScopedAsync({ scopeKey: previewKey, enabled: Boolean(data && canRead && canWrite && hotelUid && draft.budgetMonth && draft.budgetCategoryId), load: loadPreview });
  const original = data?.detail?.request, settings = data?.context?.settings || {}, currency = settings.currency || original?.currency || "EUR";
  const editable = !original || (original.requesterUid === auth.currentUser?.uid && ["draft", "returned"].includes(original.status));
  const totalMinor = requestLineTotalMinor(draft.lines), budget = preview?.budget?.exists === false ? null : preview?.budget;
  const sameBucket = original?.reservation?.bucketId === `${draft.budgetMonth}__${draft.budgetCategoryId}`;
  const heldMinor = sameBucket && original?.reservation?.state === "pending" ? original.reservation.amountMinor : 0;
  const impact = requestBudgetImpact(budget, totalMinor, heldMinor);
  const locked = busy || Boolean(pending) || !editable;
  const change = (name, value) => setDraft((before) => ({ ...before, [name]: value }));
  const changeLine = (id, patch) => setDraft((before) => ({ ...before, lines: before.lines.map((line) => line.id === id ? { ...line, ...patch } : line) }));
  const refreshPending = () => { try { setPending(getPendingPurchaseRequestCommand(hotelUid, purchaseRequestId || "create")); } catch (failure) { setError(failure.message); } };
  const save = async (event, recover = false) => {
    event?.preventDefault(); if (busy || !canWrite || !canRead || !editable) return;
    const actor = auth.currentUser; setBusy(true); setError("");
    try {
      const inputDraft = { ...draftState.current, lines: draftState.current.lines.filter((line) => line.kind !== "free" || line.supplierId || line.description.trim() || line.unitPrice !== "").map(inputLine) };
      if (!recover && requestLineTotalMinor(inputDraft.lines) == null) throw new Error("Enter a positive quantity and a net unit price for each line, using up to six decimal places and values no greater than 1,000,000.");
      const result = recover ? await retryPurchaseRequestCommand(hotelUid, purchaseRequestId || "create") : await mutatePurchaseRequest(hotelUid, { action: purchaseRequestId ? "save" : "create", ...(purchaseRequestId ? { purchaseRequestId } : {}), expectedRevision: original?.revision || 0, draft: inputDraft });
      if (mounted.current && actor === auth.currentUser) navigate(`/purchase-requests/${encodeURIComponent(result.purchaseRequestId || result.request.id)}`);
    } catch (failure) { if (mounted.current && actor === auth.currentUser) { setError(failure.message); refreshPending(); } }
    finally { if (mounted.current && actor === auth.currentUser) setBusy(false); }
  };
  const changeSupplier = (lineId, supplierId) => setDraft((before) => ({ ...before, lines: before.lines.map((line) => line.id !== lineId || line.supplierId === supplierId ? line : { id: line.id, kind: "free", supplierId, supplierName: (data?.context?.suppliers || []).find((supplier) => supplier.id === supplierId)?.name || "", description: line.description, quantity: line.quantity, unitPrice: "", unit: line.kind === "supplier" ? "each" : line.unit, supplierChanged: Boolean(line.supplierId || line.supplierChanged) }) }));
  const chooseSupplierProduct = (lineId, supplierId, product, option = null) => {
    const price = product.currency && product.currency !== currency ? null : option ? option.pricePerPurchaseUnit : product.pricePerPurchaseUnit;
    setDraft((before) => ({ ...before, lines: before.lines.map((line) => line.id !== lineId || line.supplierId !== supplierId ? line : { ...line, kind: "supplier", supplierProductId: product.id, purchaseOptionId: option?.id || null, description: product.supplierProductName || product.name || "", unitPrice: price == null ? "" : String(price), unit: option?.purchaseUnit || product.purchaseUnit || "each", supplierChanged: false, priceReview: { requiresQuote: product.requiresQuote, priceNeedsReview: product.priceNeedsReview, priceValidity: product.priceValidity, priceReviewReasons: product.priceReviewReasons, currency: product.currency } }) }));
  };
  const upload = async (event) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file || !purchaseRequestId || locked) return;
    const actor = auth.currentUser; setBusy(true); setError("");
    try {
      const result = await uploadPurchaseRequestAttachment(hotelUid, purchaseRequestId, file, original.revision);
      if (!mounted.current || actor !== auth.currentUser) return;
      const attachment = result.attachment;
      setAttachments((values) => [...values, attachment]);
      setDraft((before) => ({ ...before, attachmentIds: [...before.attachmentIds, attachment.fileId || attachment.id] }));
    } catch (failure) { if (mounted.current && actor === auth.currentUser) setError(failure.message); }
    finally { if (mounted.current && actor === auth.currentUser) setBusy(false); }
  };
  if (!hotelUid || !canRead || !canWrite) return <RequestError error="You do not have permission to edit purchase requests in this hotel." />;
  const hasEnteredLines = draft.lines.some((line) => line.supplierId || line.description.trim() || line.unitPrice !== "");
  return <>
    <header>
      <Link className="text-sm font-medium text-brand-800 underline" to={purchaseRequestId ? `/purchase-requests/${purchaseRequestId}` : "/purchase-requests"}>← {purchaseRequestId ? "Request details" : "Purchase Requests"}</Link>
      <h1 className="mt-3 text-3xl font-semibold">{purchaseRequestId ? "Edit purchase request" : "New purchase request"}</h1>
      <p className="mt-2 text-sm text-stone-600">Prepare your request, then save the draft to review it and select an approver.</p>
    </header>
    <RequestError error={loadError} onRetry={retry} /><RequestError error={error} />
    {loading && <p role="status">Loading request…</p>}
    <RequestRecovery pending={pending} disabled={busy} onRetry={() => save(null, true)} />
    {data && !editable && <RequestError error={original?.requesterUid !== auth.currentUser?.uid ? "Only the requester can edit this draft." : "This request is no longer editable. Open its details to review the current decision or start a revision."} />}
    {data && initialized && editable && <form onSubmit={save} className="space-y-4">
      <fieldset disabled={locked} className="min-w-0 space-y-4">
        <section aria-labelledby="request-details-heading" className="space-y-4 rounded-xl border bg-white p-4 sm:p-5">
          <h2 id="request-details-heading" className="font-semibold">Request details</h2>
          <div className="grid gap-5 min-[1100px]:grid-cols-2 min-[1100px]:gap-8">
            <div className="min-w-0 space-y-4">
              <label className="block max-w-3xl text-sm font-medium">Title<input className={field} value={draft.title} onChange={(event) => change("title", event.target.value)} maxLength={200} placeholder="For example: Replace restaurant chinaware" /></label>
              <label className="block max-w-3xl text-sm font-medium">Business reason<textarea className={field} rows={2} value={draft.motivation} onChange={(event) => change("motivation", event.target.value)} maxLength={3000} placeholder="Why is this purchase needed?" /></label>
            </div>
            <div className="grid content-start gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium">Cost centre / department<select className={field} value={draft.costCentreId} onChange={(event) => change("costCentreId", event.target.value)}><option value="">Choose a cost centre</option>{(settings.costCentres || []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label className="text-sm font-medium">Budget category<select className={field} value={draft.budgetCategoryId} onChange={(event) => change("budgetCategoryId", event.target.value)}><option value="">Choose a category</option>{(settings.budgetCategories || []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label className="text-sm font-medium sm:col-span-2 sm:max-w-[12rem]">Budget month<input type="month" className={field} value={draft.budgetMonth} onChange={(event) => change("budgetMonth", event.target.value)} /></label>
            </div>
          </div>
          <details className="max-w-3xl" open={Boolean(original?.description)}>
            <summary className="min-h-[44px] content-center text-sm font-medium text-brand-800">Additional description <span className="font-normal text-stone-500">· Optional</span></summary>
            <label className="mt-2 block text-sm font-medium">Description<textarea className={field} rows={2} value={draft.description} onChange={(event) => change("description", event.target.value)} maxLength={3000} placeholder="Add request-wide specifications or context" /></label>
          </details>
        </section>
        <section aria-labelledby="request-lines-heading" className="min-w-0 rounded-xl border bg-white p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="request-lines-heading" className="font-semibold">Purchase lines</h2>
            <p className="text-xs text-stone-600">{currency} · Excl. VAT</p>
          </div>
          <div aria-hidden="true" className="ht-purchase-line-grid mt-4 hidden items-center border-b pb-2 text-xs font-medium text-stone-500 min-[1100px]:grid">
            <span>Product / description</span><span>Supplier</span><span>Purchase unit</span><span>Quantity</span><span>Net unit price</span><span className="text-right">Line total</span><span />
          </div>
          <div className="mt-3 divide-y divide-stone-200 min-[1100px]:mt-0">
            {draft.lines.map((line, index) => <PurchaseRequestLineEditor key={line.id} line={line} index={index} suppliers={data.context.suppliers || []} hotelUid={hotelUid} scopeKey={scopeKey} currency={currency} locked={locked} onChange={(patch) => changeLine(line.id, patch)} onSupplierChange={(supplierId) => changeSupplier(line.id, supplierId)} onChooseProduct={(product, option) => chooseSupplierProduct(line.id, line.supplierId, product, option)} onRemove={() => setDraft((before) => ({ ...before, lines: before.lines.filter((entry) => entry.id !== line.id) }))} />)}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-4 border-t pt-4">
            <button type="button" className="ht-button-secondary inline-flex items-center gap-2" onClick={() => setDraft((before) => ({ ...before, lines: [...before.lines, newLine()] }))} disabled={draft.lines.length >= 50}><Plus size={16} aria-hidden="true" />Add purchase line</button>
            <div className="flex max-w-full flex-wrap items-baseline gap-x-3 gap-y-1"><span className="text-sm text-stone-600">Request total</span><output aria-label="Request total" className="min-w-0 break-words text-xl font-semibold tabular-nums">{totalMinor == null ? "—" : purchaseRequestMoney(totalMinor, currency)}</output></div>
          </div>
          {totalMinor == null && hasEnteredLines && <p className="mt-3 text-sm text-stone-600">Enter valid quantities and net unit prices to calculate the complete request total.</p>}
          <div className="mt-4">
            <RequestError error={previewError} onRetry={retryPreview} />
            {draft.budgetMonth && draft.budgetCategoryId && totalMinor != null && <>{previewLoading ? <p role="status" className="text-sm text-stone-600">Updating budget impact…</p> : <RequestBudgetSummary compact budget={budget} currency={currency} totalMinor={totalMinor} heldMinor={heldMinor} {...impact} />}</>}
          </div>
        </section>
        <details className="rounded-xl border bg-white p-4 sm:px-5" open={Boolean(draft.attachmentIds.length)}>
          <summary className="min-h-[44px] content-center text-sm font-medium text-brand-800"><Paperclip size={16} className="mr-2 inline-block" aria-hidden="true" />Attachments <span className="font-normal text-stone-500">· {draft.attachmentIds.length ? `${draft.attachmentIds.length} attached` : "Optional"}</span></summary>
          {!purchaseRequestId ? <p className="mt-2 text-sm text-stone-600">Save the draft to add quotes or supporting documents.</p> : <>
            <label className="mt-3 block text-sm font-medium">Add supporting document<input type="file" className={`${field} text-sm`} accept={PURCHASE_REQUEST_ATTACHMENT_ACCEPT} onChange={upload} disabled={locked || draft.attachmentIds.length >= 10} /></label>
            <p className="mt-2 text-xs text-stone-500">Up to 10 files, 10 MiB each. Save the draft to attach uploaded documents.</p>
          </>}
          <ul className="mt-3 space-y-2">{attachments.filter((attachment) => draft.attachmentIds.includes(attachment.fileId || attachment.id)).map((attachment) => <li key={attachment.fileId || attachment.id} className="flex items-center justify-between gap-3 rounded-lg bg-stone-50 px-3 py-2 text-sm"><span className="min-w-0 break-words">{attachment.name || attachment.fileName}</span><button type="button" className="min-h-[44px] shrink-0 px-2 text-red-800" onClick={() => change("attachmentIds", draft.attachmentIds.filter((id) => id !== (attachment.fileId || attachment.id)))}>Remove</button></li>)}</ul>
        </details>
      </fieldset>
      <footer className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-white p-4">
        <div className="text-xs text-stone-600"><p>{draft.lines.length} {draft.lines.length === 1 ? "purchase line" : "purchase lines"}</p><p className="mt-1">Save to review and choose an approver. The budget reservation changes on submission.</p></div>
        <button className="ht-button-primary" type="submit" disabled={locked}>{busy ? "Saving…" : "Save draft"}</button>
      </footer>
    </form>}
  </>;
}
