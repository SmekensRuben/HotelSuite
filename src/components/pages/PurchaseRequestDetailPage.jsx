import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import PageShell from "../layout/PageShell";
import Modal from "../shared/Modal";
import { useHotelContext } from "../../contexts/HotelContext";
import { usePermission } from "../../hooks/usePermission";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { auth } from "../../firebaseConfig";
import { getPurchaseRequest, getPurchaseRequestContext, getPendingPurchaseRequestCommand, mutatePurchaseRequest, retryPurchaseRequestCommand } from "../../services/firebasePurchaseRequests";
import { downloadPurchaseRequestAttachment } from "../../services/firebasePurchaseRequestAttachments";
import PurchaseRequestNotifications from "../purchasing/PurchaseRequestNotifications";
import { eligibleRequestApprovers, purchaseRequestMoney, purchaseRequestStatusLabel, purchaseRequestTime, purchaseRequestUnitPrice } from "../../utils/purchaseRequests";
import { requestFieldClass as field, RequestError, RequestRecovery, RequestStatus } from "../purchasing/PurchaseRequestShared";

const actionLabels = { submit: "Submit request", approve: "Approve", reject: "Reject", return: "Return for changes", withdraw: "Withdraw request", cancel: "Cancel request", revise: "Start a revision" };
const actionExplanations = { submit: "Submit these prices and attachments as a frozen version. The net amount will be reserved in the chosen budget month.", approve: "Approve the submitted version. Any required next step remains pending; only the final step changes the reservation into an approved commitment.", reject: "Reject this version and release its budget reservation.", return: "Send this request back for changes. Its current budget reservation stays held until it is resubmitted, withdrawn or canceled.", withdraw: "Withdraw this request and release its reserved amount.", cancel: "Cancel this request and release its reservation or approved commitment. Earlier decisions remain in its history.", revise: "Reopen this request for changes. Previous submitted versions and decisions remain in the history; the revised version must be approved again." };
function ApprovalEscalationNote({ escalation, preview = false }) {
  if (escalation?.reason !== "requester-only-first-step") return null;
  return <p className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950">{escalation.fromStepName} {preview ? "will be escalated" : "was escalated"} to {escalation.toStepName} because the requester {preview ? "is" : "was"} the only eligible approver for {escalation.fromStepName}. An independent approver must review the full request. The requester cannot approve their own request.</p>;
}
const eventLabels = { create: "Draft created", save: "Draft saved", submit: "Submitted for approval", approve: "Approval step completed", approved: "Finally approved", reject: "Rejected", return: "Returned for changes", withdraw: "Withdrawn", cancel: "Canceled", revise: "Revision opened" };

export default function PurchaseRequestDetailPage() {
  const { purchaseRequestId } = useParams(), { hotelUid } = useHotelContext();
  const canRead = usePermission("purchaserequests", "read");
  return <PageShell variant="procurement"><RequestDetail key={`${hotelUid}:${auth.currentUser?.uid}:${purchaseRequestId}:${canRead}`} hotelUid={hotelUid} purchaseRequestId={purchaseRequestId} canRead={canRead} /></PageShell>;
}
function RequestDetail({ hotelUid, purchaseRequestId, canRead }) {
  const { permissions } = useHotelContext();
  const canUpdate = usePermission("purchaserequests", "update"), canSubmit = usePermission("purchaserequests", "submit"), canApprove = usePermission("purchaserequests", "approve"), canCancel = usePermission("purchaserequests", "cancel");
  const scopeKey = `${hotelUid}:${auth.currentUser?.uid}:${purchaseRequestId}:${canRead}:${JSON.stringify(permissions)}`;
  const mounted = useRef(true), [busy, setBusy] = useState(false), [error, setError] = useState(""), [pending, setPending] = useState(null);
  const [historyBusy, setHistoryBusy] = useState(false), latestScope = useRef(scopeKey), currentRevision = useRef(null);
  latestScope.current = scopeKey;
  const [action, setAction] = useState(null), [reason, setReason] = useState(""), [approverUid, setApprover] = useState(""), [nextApproverUid, setNextApprover] = useState("");
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const load = useCallback(async () => {
    const [detail, context] = await Promise.all([getPurchaseRequest(hotelUid, purchaseRequestId), getPurchaseRequestContext(hotelUid)]);
    return { ...detail, context };
  }, [hotelUid, purchaseRequestId]);
  const { data, loading, error: loadError, retry, setData } = useScopedAsync({ scopeKey, enabled: Boolean(hotelUid && canRead && purchaseRequestId), load });
  const readPending = useCallback(() => { try { setPending(getPendingPurchaseRequestCommand(hotelUid, purchaseRequestId)); } catch (failure) { setError(failure.message); } }, [hotelUid, purchaseRequestId]);
  useEffect(() => { if (hotelUid && canRead) readPending(); }, [hotelUid, canRead, readPending]);
  const request = data?.request, userUid = auth.currentUser?.uid, owner = request?.requesterUid === userUid;
  currentRevision.current = request?.revision;
  const assigned = request?.currentApproverUid === userUid && !owner && request?.status === "pending";
  const steps = request?.approvalSteps || [];
  const selectedSteps = (data?.context?.settings?.approvalSteps || []).filter((step) => Number(step.thresholdMinor || 0) <= Number(request?.totalMinor || 0));
  const preparingSubmission = owner && ["draft", "returned"].includes(request?.status);
  const hasSubmissionRoute = Boolean(data && Object.prototype.hasOwnProperty.call(data, "submissionApprovalRoute"));
  const submissionRoute = preparingSubmission && hasSubmissionRoute ? data.submissionApprovalRoute : null;
  const validSubmissionRoute = submissionRoute && Array.isArray(submissionRoute.steps) && Array.isArray(submissionRoute.approvers) && /^[a-f0-9]{64}$/.test(submissionRoute.fingerprint || "");
  const submissionRouteError = preparingSubmission && hasSubmissionRoute && (!validSubmissionRoute || submissionRoute.error)
    ? submissionRoute?.error?.message || "The approval route could not be verified. Refresh the request before submitting."
    : "";
  const firstStep = hasSubmissionRoute ? submissionRoute?.steps?.[0] : selectedSteps[0];
  const nextStep = steps[Number(request?.currentStepIndex || 0) + 1] || (request?.status === "pending" && Number(data?.budget?.remainingMinor) < 0 && data?.context?.settings?.overBudgetMode === "approval" && !steps.some((step) => step.id === "over-budget") ? { id: "over-budget", name: "Additional budget approval" } : null);
  const firstApprovers = hasSubmissionRoute
    ? (Array.isArray(submissionRoute?.approvers) ? submissionRoute.approvers : []).filter((person) => person.uid && person.uid !== request?.requesterUid)
    : eligibleRequestApprovers(data?.context, request?.requesterUid, firstStep?.id, request?.totalMinor || 0);
  const submissionUnavailable = Boolean(submissionRouteError) || !firstStep || !firstApprovers.length;
  const submissionProblem = submissionRouteError || (submissionUnavailable ? "No eligible first approver is configured for this amount. Ask your hotel administrator to review the approval settings." : "");
  const progressSteps = preparingSubmission && hasSubmissionRoute ? (Array.isArray(submissionRoute?.steps) ? submissionRoute.steps : []) : steps;
  const priorApprovers = new Set([userUid, ...(request?.approvals || []).map((approval) => approval.approverUid)]);
  const nextApprovers = (nextStep?.id === "over-budget" ? (data?.context?.approvers || []).filter((user) => user.uid !== request?.requesterUid && user.eligible !== false && user.canApproveOverBudget && (user.limitMinor == null || user.limitMinor >= request.totalMinor)) : eligibleRequestApprovers(data?.context, request?.requesterUid, nextStep?.id, request?.totalMinor || 0)).filter((user) => !priorApprovers.has(user.uid));
  const status = request?.status;
  const allowedActions = {
    submit: owner && canSubmit && ["draft", "returned"].includes(status),
    approve: assigned && canApprove, reject: assigned && canApprove, return: assigned && canApprove,
    withdraw: owner && canCancel && ["pending", "returned"].includes(status),
    cancel: owner && canCancel && ["draft", "pending", "returned", "approved"].includes(status),
    revise: owner && canUpdate && ["pending", "approved"].includes(status),
  };
  const perform = async (recover = false) => {
    if (busy || !canRead || (!recover && (!allowedActions[action] || (action === "submit" && (submissionUnavailable || !firstApprovers.some((person) => person.uid === approverUid)))))) return;
    const actor = auth.currentUser; setBusy(true); setError("");
    try {
      const result = recover ? await retryPurchaseRequestCommand(hotelUid, purchaseRequestId) : await mutatePurchaseRequest(hotelUid, { purchaseRequestId, expectedRevision: request.revision, action, ...(action === "submit" ? { approverUid, ...(hasSubmissionRoute ? { expectedApprovalRouteFingerprint: submissionRoute.fingerprint } : {}) } : {}), ...(action === "approve" && nextStep ? { nextApproverUid } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}) });
      if (!mounted.current || actor !== auth.currentUser) return;
      setAction(null); setReason(""); setApprover(""); setNextApprover(""); setPending(null);
      if (result.request) setData((value) => ({ ...value, request: result.request, budget: result.budget }));
      await retry();
    } catch (failure) { if (mounted.current && actor === auth.currentUser) { setError(failure.message); readPending(); } }
    finally { if (mounted.current && actor === auth.currentUser) setBusy(false); }
  };
  const download = async (attachment, revision = request.revision) => {
    const actor = auth.currentUser; setBusy(true); setError("");
    try {
      const blob = await downloadPurchaseRequestAttachment(hotelUid, purchaseRequestId, attachment, revision);
      if (!mounted.current || actor !== auth.currentUser) return;
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = attachment.name || attachment.fileName || "attachment"; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) { if (mounted.current && actor === auth.currentUser) setError(failure.message); }
    finally { if (mounted.current && actor === auth.currentUser) setBusy(false); }
  };
  const begin = (value) => { setReason(""); setApprover(""); setNextApprover(""); setAction(value); };
  const refreshRequest = () => { setAction(null); setApprover(""); setNextApprover(""); setError(""); retry(); };
  const loadOlderHistory = async () => {
    if (historyBusy || !data?.nextHistoryCursor || !canRead) return;
    const actor = auth.currentUser, revision = request.revision, cursor = data.nextHistoryCursor, requestedScope = scopeKey;
    setHistoryBusy(true); setError("");
    try {
      const page = await getPurchaseRequest(hotelUid, purchaseRequestId, { historyBeforeRevision: cursor });
      if (!mounted.current || auth.currentUser !== actor || latestScope.current !== requestedScope || currentRevision.current !== revision) return;
      if (page.request?.revision !== revision) throw new Error("The request changed while loading its history. Refresh the request before continuing.");
      if (!Array.isArray(page.history) || page.history.some((event) => !Number.isSafeInteger(event.revision) || event.revision >= cursor)) throw new Error("The older history page could not be verified. Refresh and try again.");
      setData((value) => value?.request?.revision !== revision ? value : { ...value, history: [...(value.history || []), ...page.history.filter((event) => !(value.history || []).some((existing) => existing.revision === event.revision))], nextHistoryCursor: page.nextHistoryCursor, historyTruncated: page.historyTruncated });
    } catch (failure) { if (mounted.current && auth.currentUser === actor && latestScope.current === requestedScope && currentRevision.current === revision) setError(failure.message); }
    finally { if (mounted.current && latestScope.current === requestedScope) setHistoryBusy(false); }
  };
  if (!hotelUid || !canRead) return <RequestError error="You do not have permission to read this hotel's purchase requests." />;
  const currency = request?.currency || "EUR", budget = data?.budget;
  const requiresReason = ["reject", "return", "cancel", "revise"].includes(action);
  const confirmDisabled = busy || loading || Boolean(pending) || !allowedActions[action] || (action === "submit" && (submissionUnavailable || !firstApprovers.some((person) => person.uid === approverUid))) || (action === "approve" && nextStep && !nextApproverUid) || (requiresReason && !reason.trim());
  return <>
    <header><Link to="/purchase-requests" className="text-sm font-medium text-brand-800 underline">← Purchase Requests</Link><div className="mt-3 flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-3xl font-semibold">{request?.title || "Purchase request"}</h1><p className="mt-2 text-sm text-stone-600">A reviewed internal purchase and budget commitment.</p></div><div className="flex flex-wrap items-center gap-2">{request && <RequestStatus status={request.status} />}<button type="button" className="ht-button-secondary text-sm" disabled={busy || loading || historyBusy} onClick={refreshRequest}>Refresh request</button></div></div></header>
    <RequestError error={loadError} onRetry={retry} />{!action && <RequestError error={error} />}
    <RequestRecovery pending={pending} disabled={busy} onRetry={() => perform(true)} />
    {loading && <p role="status" className="text-sm">Loading request…</p>}
    {request && <>
      <section className="grid gap-5 rounded-xl border bg-white p-5 sm:grid-cols-2 lg:grid-cols-3" aria-label="Request summary"><div><p className="text-xs uppercase text-stone-500">Net request total</p><p className="mt-1 text-2xl font-semibold">{purchaseRequestMoney(request.totalMinor, currency)}</p><p className="mt-1 text-xs text-stone-600">{currency} · Excluding VAT</p></div><div><p className="text-xs text-stone-500">Supplier</p><p className="mt-1 font-semibold">{request.supplier?.name || "Not selected"}</p><p className="mt-2 text-xs text-stone-500">Requested by {request.requesterName || request.requesterEmail || request.requesterUid}</p></div><div><p className="text-xs text-stone-500">Budget month</p><p className="mt-1 font-semibold">{request.budgetMonth || "Not selected"}</p><p className="mt-2 text-sm text-stone-600">{request.budgetCategoryName || "Category not selected"} · {request.costCentreName || "Cost centre not selected"}</p></div>{request.description && <div className="sm:col-span-2 lg:col-span-3"><h2 className="text-xs font-semibold uppercase text-stone-500">Description</h2><p className="mt-2 whitespace-pre-wrap text-sm">{request.description}</p></div>}{request.motivation && <div className="sm:col-span-2 lg:col-span-3"><h2 className="text-xs font-semibold uppercase text-stone-500">Business reason</h2><p className="mt-2 whitespace-pre-wrap text-sm">{request.motivation}</p></div>}</section>
      <section aria-label="Approval progress" className="rounded-xl border bg-white p-5"><h2 className="font-semibold">Approval progress</h2><p className="mt-2 text-sm">{request.status === "pending" ? `Awaiting ${request.currentApproverName || request.currentApproverUid || "an assigned approver"}` : purchaseRequestStatusLabel(request.status)}</p>{request.status === "returned" && <p className="mt-2 text-sm text-amber-900">The submitted amount remains reserved. Changes must be saved and submitted again; earlier approvals do not carry over.</p>}{request.status === "approved" && <p className="mt-2 text-sm text-emerald-900">The approved amount is a commitment, not an invoice cost. Its reservation was transferred without deducting the budget twice.</p>}{preparingSubmission && <><ApprovalEscalationNote escalation={submissionRoute?.escalation} preview />{submissionProblem && <div role="alert" className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-950"><p>{submissionProblem}</p><button type="button" className="ht-button-secondary mt-3" disabled={busy || loading || historyBusy} onClick={refreshRequest}>Refresh approval route</button></div>}</>}{!preparingSubmission && <ApprovalEscalationNote escalation={request.approvalEscalation} />}{request.lastDecisionReason && <p className="mt-3 whitespace-pre-wrap rounded-lg bg-stone-50 p-3 text-sm">{request.lastDecisionReason}</p>}<ol className="mt-4 space-y-2">{progressSteps.map((step, index) => { const approval = preparingSubmission ? null : (request.approvals || []).find((item) => item.stepId === step.id); return <li key={step.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-stone-50 px-3 py-2 text-sm"><span>{index + 1}. {step.name}</span><span className="text-xs text-stone-600">{approval ? `Approved by ${approval.approverName || approval.approverUid}` : request.status === "pending" && index === request.currentStepIndex ? "Current step" : preparingSubmission ? "Required on submission" : "Pending"}</span></li>; })}</ol></section>
      <section aria-label="Budget position" className="rounded-xl border border-stone-200 bg-stone-50 p-5"><h2 className="font-semibold">Budget position · {request.budgetMonth || "Month not selected"}</h2><p className="mt-1 text-xs text-stone-600">All amounts exclude VAT. Opening usage and approved commitments remain separate.</p>{!budget || budget.exists === false ? <p className="mt-3 text-sm font-medium">No budget configured for this category and month.</p> : <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">{[["Budget", budget.budgetMinor], ["Opening usage", budget.openingUsedMinor], ["Requests pending", budget.pendingMinor], ["Approved commitments", budget.committedMinor], ["Available", budget.remainingMinor]].map(([label, amount]) => <div key={label}><dt className="text-xs text-stone-600">{label}</dt><dd className="mt-1 font-semibold">{purchaseRequestMoney(amount, currency)}</dd></div>)}</dl>}<p className="mt-3 text-xs text-stone-600">This request: {request.reservation?.state === "pending" ? "Reserved as pending" : request.reservation?.state === "committed" ? "Approved commitment" : "No budget reserved"}{request.reservation?.amountMinor ? ` · ${purchaseRequestMoney(request.reservation.amountMinor, currency)}` : ""}</p></section>
      <section aria-label="Purchase lines" className="rounded-xl border bg-white p-5"><h2 className="font-semibold">Purchase lines</h2><p className="mt-1 text-xs text-stone-600">Submitted and approved versions retain their reviewed prices and product details.</p><div className="mt-4 space-y-3">{(request.lines || []).map((line, index) => <article key={line.id || index} className="rounded-lg border p-4"><div className="flex flex-wrap justify-between gap-2"><p className="font-medium">{line.description || line.supplierProductName}</p><p className="font-semibold">{purchaseRequestMoney(line.lineTotalMinor, currency)}</p></div><p className="mt-2 text-sm text-stone-600">{line.quantity} {line.unit || "units"} × {purchaseRequestUnitPrice(line.unitPrice, currency)} net</p>{line.supplierSku && <p className="mt-1 text-xs text-stone-500">Supplier article {line.supplierSku}{line.priceVersionId ? ` · Price version ${line.priceVersionId}` : ""}</p>}</article>)}</div></section>
      <section aria-label="Request attachments" className="rounded-xl border bg-white p-5"><h2 className="font-semibold">Attachments</h2>{!request.attachments?.length && <p className="mt-2 text-sm text-stone-600">No supporting documents attached.</p>}<ul className="mt-3 space-y-2">{(request.attachments || []).map((attachment) => <li key={attachment.fileId || attachment.id}><button type="button" className="ht-button-secondary min-h-[44px] text-left" disabled={busy} onClick={() => download(attachment)}>{attachment.name || attachment.fileName || "Supporting document"}</button></li>)}</ul>{owner && canUpdate && ["draft", "returned"].includes(status) && <Link className="mt-3 inline-flex text-sm font-medium text-brand-800 underline" to={`/purchase-requests/${encodeURIComponent(purchaseRequestId)}/edit`}>Edit draft and attachments</Link>}</section>
      <PurchaseRequestNotifications hotelUid={hotelUid} purchaseRequestId={purchaseRequestId} revision={request.revision} />
      <section aria-label="Request timeline" className="rounded-xl border bg-white p-5"><h2 className="font-semibold">Timeline and reviewed versions</h2><ol className="mt-4 space-y-4">{[...(data.history || [])].sort((a, b) => Number(b.revision) - Number(a.revision)).map((event) => <li key={`${event.revision}:${event.event}`} className="border-l-2 border-stone-200 pl-4"><p className="text-sm font-semibold">{eventLabels[event.event] || "Request updated"} · Version {event.revision}</p><p className="mt-1 text-xs text-stone-500">{event.actorName || event.actorUid} · {purchaseRequestTime(event.createdAtMillis)}</p>{event.reason && <p className="mt-2 whitespace-pre-wrap text-sm">{event.reason}</p>}{event.snapshot && <details className="mt-2 text-xs"><summary className="min-h-[32px] cursor-pointer font-medium text-brand-800">View frozen version</summary><div className="mt-2 space-y-2 rounded-lg bg-stone-50 p-3"><p>{event.snapshot.title} · {purchaseRequestMoney(event.snapshot.totalMinor, event.snapshot.currency || currency)} net · {event.snapshot.budgetMonth}</p><p>{event.snapshot.supplier?.name} · {event.snapshot.costCentreName} · {event.snapshot.budgetCategoryName}</p><p className="whitespace-pre-wrap">{event.snapshot.motivation}</p><ApprovalEscalationNote escalation={event.snapshot.approvalEscalation} />{event.snapshot.approvalSteps?.length > 0 && <p>Approval route: {event.snapshot.approvalSteps.map((step) => step.name).join(" → ")}</p>}<ul className="space-y-1">{(event.snapshot.lines || []).map((line, index) => <li key={line.id || index}>{line.description || line.supplierProductName}: {line.quantity} {line.unit} × {line.unitPrice} {currency} net = {purchaseRequestMoney(line.lineTotalMinor, currency)}</li>)}</ul>{(event.snapshot.attachments || []).map((attachment) => <button key={attachment.fileId || attachment.id} type="button" className="ht-button-secondary text-xs" disabled={busy} onClick={() => download(attachment, event.revision)}>Download {attachment.name || attachment.fileName}</button>)}</div></details>}</li>)}</ol>{data.nextHistoryCursor && <button type="button" className="ht-button-secondary mt-4" disabled={historyBusy || busy || loading} onClick={loadOlderHistory}>{historyBusy ? "Loading older history…" : "Load older history"}</button>}</section>
      <footer className="sticky bottom-3 flex flex-wrap items-center gap-2 rounded-xl border bg-white p-4 shadow-sm" aria-label="Request actions">{owner && canUpdate && ["draft", "returned"].includes(status) && <Link className="ht-button-secondary" to={`/purchase-requests/${encodeURIComponent(purchaseRequestId)}/edit`}>Edit draft</Link>}{Object.entries(allowedActions).filter(([, allowed]) => allowed).map(([value]) => <button key={value} type="button" className={value === "submit" || value === "approve" ? "ht-button-primary" : "ht-button-secondary"} disabled={busy || loading || Boolean(pending) || (value === "submit" && submissionUnavailable)} onClick={() => begin(value)}>{actionLabels[value]}</button>)}{!Object.values(allowedActions).some(Boolean) && <p className="text-xs text-stone-600">No decision is available for your account at this step.</p>}</footer>
    </>}
    <Modal open={Boolean(action)} onClose={() => { if (!busy) setAction(null); }} title={actionLabels[action] || "Review action"}><p className="text-sm text-stone-600">{actionExplanations[action]}</p><RequestError error={error} />{action === "submit" && <><ApprovalEscalationNote escalation={submissionRoute?.escalation} preview /><label className="mt-4 block text-sm font-medium">First approver{firstStep ? ` · ${firstStep.name}` : ""}<select className={field} value={approverUid} disabled={busy || Boolean(submissionRouteError)} onChange={(event) => setApprover(event.target.value)}><option value="">Choose an authorized approver</option>{firstApprovers.map((user) => <option key={user.uid} value={user.uid}>{user.name || user.displayName || user.email || user.uid}</option>)}</select></label>{submissionProblem && <p role="alert" className="mt-2 text-sm text-amber-900">{submissionProblem}</p>}<p className="mt-3 text-xs text-stone-600">{purchaseRequestMoney(request?.totalMinor, currency)} net will be reserved in {request?.budgetMonth || "the selected month"}. Missing budgets and blocked overruns prevent submission.</p></>}{action === "approve" && nextStep && <label className="mt-4 block text-sm font-medium">Next approver · {nextStep.name}<select className={field} value={nextApproverUid} onChange={(event) => setNextApprover(event.target.value)}><option value="">Choose the next authorized approver</option>{nextApprovers.map((user) => <option key={user.uid} value={user.uid}>{user.name || user.displayName || user.email || user.uid}</option>)}</select>{!nextApprovers.length && <span role="alert" className="mt-2 block text-sm text-amber-900">No eligible approver is configured for the next required step.</span>}</label>}{action && <label className="mt-4 block text-sm font-medium">Decision note{requiresReason ? " (required)" : " (optional)"}<textarea className={field} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={2000} /></label>}<div className="mt-5 flex justify-end gap-2"><button type="button" className="ht-button-secondary" disabled={busy} onClick={() => setAction(null)}>Back</button><button type="button" className="ht-button-primary" disabled={confirmDisabled} onClick={() => perform()}>{busy ? "Processing…" : `Confirm ${action === "return" ? "return for changes" : action || "action"}`}</button></div></Modal>
  </>;
}
