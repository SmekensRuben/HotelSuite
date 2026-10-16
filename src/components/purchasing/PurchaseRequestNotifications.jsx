import React, { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { getPurchaseRequestNotifications, retryPurchaseRequestNotification } from "../../services/firebasePurchaseRequestNotifications";

const labels = { selfapprove: "Independent review after self-approval", selfapproved: "Self-approved registration", submit: "First approver", approve: "Next approver", approved: "Final approval", reject: "Rejection", return: "Returned for changes" };
const statuses = { queued: "Queued", processing: "Sending", sent: "Sent", blocked: "No longer applicable", failed: "Email configuration needs attention", "needs-review": "Delivery outcome needs review" };

export default function PurchaseRequestNotifications({ hotelUid, purchaseRequestId, revision }) {
  const [state, setState] = useState({ key: "", notifications: [], busy: false, error: "" });
  const scope = `${hotelUid || ""}/${purchaseRequestId || ""}/${revision || 0}`;
  const currentScope = useRef(scope), sequence = useRef(0);
  currentScope.current = scope;
  const load = useCallback(async () => {
    const call = ++sequence.current;
    setState((previous) => ({ key: scope, notifications: previous.key === scope ? previous.notifications : [], busy: true, error: "" }));
    try {
      const result = await getPurchaseRequestNotifications(hotelUid, purchaseRequestId);
      if (currentScope.current === scope && sequence.current === call) setState({ key: scope, notifications: result.notifications || [], busy: false, error: "" });
    } catch (error) {
      if (currentScope.current === scope && sequence.current === call) setState({ key: scope, notifications: [], busy: false, error: error.message || "Unable to load email delivery status." });
    }
  }, [hotelUid, purchaseRequestId, scope]);
  useEffect(() => {
    currentScope.current = scope;
    if (hotelUid && purchaseRequestId) load();
    return () => { sequence.current += 1; if (currentScope.current === scope) currentScope.current = null; };
  }, [hotelUid, purchaseRequestId, load, scope]);
  const retry = async (mailId) => {
    setState((previous) => ({ ...previous, busy: true, error: "" }));
    try {
      await retryPurchaseRequestNotification(hotelUid, mailId);
      if (currentScope.current === scope) await load();
    } catch (error) {
      if (currentScope.current === scope) setState((previous) => ({ ...previous, busy: false, error: error.message || "Unable to retry this notification." }));
    }
  };
  if (!hotelUid || !purchaseRequestId) return null;
  const visible = state.key === scope ? state : { notifications: [], busy: true, error: "" };
  return <section className="rounded-xl border border-slate-200 bg-white p-4" aria-label="Email notifications">
    <div className="flex items-center justify-between gap-3">
      <h2 className="font-semibold text-slate-900">Email notifications</h2>
      <button type="button" className="ht-button-secondary inline-flex min-h-[44px] min-w-[44px] items-center justify-center" aria-label="Refresh email delivery status" title="Refresh email delivery status" disabled={visible.busy} onClick={load}><RefreshCw size={18} aria-hidden="true" /></button>
    </div>
    {visible.error && <p role="alert" className="mt-2 text-sm text-red-700">{visible.error}</p>}
    {!visible.notifications.length && <p className="mt-2 text-sm text-slate-500">{visible.busy ? "Loading email delivery status…" : "No email notifications for this revision."}</p>}
    <ul className="mt-2 space-y-2">
      {visible.notifications.map((notification) => <li key={notification.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>{labels[notification.event] || "Request update"}: <span className="font-medium">{notification.recoveredByMailId ? "Retried" : statuses[notification.status] || "Unavailable"}</span></span>
        {notification.canRetry && !notification.recoveredByMailId && <button type="button" className="ht-button-secondary" disabled={visible.busy} onClick={() => retry(notification.id)}>Retry email</button>}
        {notification.status === "needs-review" && <p className="w-full text-xs text-slate-500">Confirm the delivery outcome with the email provider before retrying.</p>}
      </li>)}
    </ul>
  </section>;
}
