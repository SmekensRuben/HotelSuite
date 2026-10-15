import React, { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { Plus } from "lucide-react";
import PageShell from "../layout/PageShell";
import { useHotelContext } from "../../contexts/HotelContext";
import { usePermission } from "../../hooks/usePermission";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { auth } from "../../firebaseConfig";
import { getPurchaseRequestContext, listPurchaseRequests } from "../../services/firebasePurchaseRequests";
import { PURCHASE_REQUEST_STATUSES, purchaseRequestMoney, purchaseRequestStatusLabel, purchaseRequestSupplierSummary } from "../../utils/purchaseRequests";
import { requestFieldClass, RequestError, RequestStatus } from "../purchasing/PurchaseRequestShared";

export default function PurchaseRequestsPage() {
  const { hotelUid } = useHotelContext();
  const canRead = usePermission("purchaserequests", "read");
  return <PageShell variant="procurement"><PurchaseRequestsList key={`${hotelUid}:${auth.currentUser?.uid}:${canRead}`} hotelUid={hotelUid} canRead={canRead} /></PageShell>;
}
function PurchaseRequestsList({ hotelUid, canRead }) {
  const canCreate = usePermission("purchaserequests", "create");
  const canBudgets = usePermission("purchasebudgets", "read");
  const [status, setStatus] = useState(""), [month, setMonth] = useState(""), [costCentreId, setCostCentre] = useState(""), [awaiting, setAwaiting] = useState(false);
  const [cursor, setCursor] = useState(null), [previous, setPrevious] = useState([]);
  const scopeKey = `${hotelUid}:${auth.currentUser?.uid}:${canRead}:${status}:${month}:${costCentreId}:${awaiting}:${cursor || ""}`;
  const load = useCallback(async () => {
    const [result, context] = await Promise.all([listPurchaseRequests(hotelUid, { ...(status ? { status } : {}), ...(month ? { month } : {}), ...(costCentreId ? { costCentreId } : {}), awaitingMyApproval: awaiting, cursor, limit: 30 }), getPurchaseRequestContext(hotelUid)]);
    return { ...result, context };
  }, [hotelUid, status, month, costCentreId, awaiting, cursor]);
  const { data, loading, error, retry } = useScopedAsync({ scopeKey, enabled: Boolean(hotelUid && canRead), load });
  const reset = (setter) => (event) => { setter(event.target.type === "checkbox" ? event.target.checked : event.target.value); setCursor(null); setPrevious([]); };
  if (!hotelUid || !canRead) return <RequestError error="Select a hotel with permission to read purchase requests." />;
  return <>
    <header className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs uppercase tracking-wider text-stone-500">Purchasing & inventory</p><h1 className="mt-1 text-3xl font-semibold">Purchase Requests</h1><p className="mt-2 text-sm text-stone-600">Plan internal purchases, reserve budget and track each approval.</p></div><div className="flex flex-wrap gap-2">{canBudgets && <Link className="ht-button-secondary" to="/purchase-budgets">Budgets</Link>}{canCreate && <Link className="ht-button-primary inline-flex items-center gap-2" to="/purchase-requests/new"><Plus size={17} aria-hidden="true" />New request</Link>}</div></header>
    <section aria-label="Purchase request filters" className="grid gap-4 rounded-xl border bg-white p-4 sm:grid-cols-2 lg:grid-cols-4"><label className="text-sm font-medium">Status<select className={requestFieldClass} value={status} onChange={reset(setStatus)}><option value="">All statuses</option>{PURCHASE_REQUEST_STATUSES.map((value) => <option key={value} value={value}>{purchaseRequestStatusLabel(value)}</option>)}</select></label><label className="text-sm font-medium">Budget month<input type="month" className={requestFieldClass} value={month} onChange={reset(setMonth)} /></label><label className="text-sm font-medium">Cost centre<select className={requestFieldClass} value={costCentreId} onChange={reset(setCostCentre)}><option value="">All cost centres</option>{(data?.context?.settings?.costCentres || []).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><label className="flex min-h-[44px] items-center gap-2 self-end text-sm font-medium"><input type="checkbox" checked={awaiting} onChange={reset(setAwaiting)} className="h-5 w-5" />Awaiting my approval</label></section>
    <RequestError error={error} onRetry={retry} />
    {loading && <p role="status" className="text-sm text-stone-600">Loading requests…</p>}
    {data && <><p className="text-xs text-stone-500">All amounts are net, excluding VAT. Approved requests are commitments, not invoice costs.</p><div className="space-y-3">{(data.requests || []).map((request) => { const supplierSummary = purchaseRequestSupplierSummary(request); return <Link key={request.id} to={`/purchase-requests/${encodeURIComponent(request.id)}`} className="block rounded-xl border border-stone-200 bg-white p-4 transition hover:border-brand-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="font-semibold text-brand-950">{request.title || "Untitled draft"}</p><p className="mt-1 text-sm text-stone-600">{supplierSummary.label} · {request.costCentreName || "No cost centre"}</p>{supplierSummary.details && <p className="mt-1 text-xs text-stone-600">{supplierSummary.details}</p>}</div><div className="flex flex-wrap items-center gap-3"><span className="font-semibold">{purchaseRequestMoney(request.totalMinor, request.currency)}</span><RequestStatus status={request.status} /></div></div><p className="mt-3 text-xs text-stone-500">{request.budgetMonth || "Month not selected"} · {request.budgetCategoryName || "No budget category"}{request.currentApproverName ? ` · With ${request.currentApproverName}` : ""}</p></Link>; })}</div>{!data.requests?.length && <section className="rounded-xl border border-dashed bg-white p-8 text-center"><h2 className="font-semibold">No requests in this view</h2><p className="mt-2 text-sm text-stone-600">Adjust the filters or start a draft for a planned purchase.</p></section>}<nav aria-label="Request pages" className="flex justify-between gap-3"><button type="button" className="ht-button-secondary" disabled={!previous.length || loading} onClick={() => { setCursor(previous[previous.length - 1]); setPrevious((values) => values.slice(0, -1)); }}>Previous</button><button type="button" className="ht-button-secondary" disabled={!data.nextCursor || loading} onClick={() => { setPrevious((values) => [...values, cursor]); setCursor(data.nextCursor); }}>Next</button></nav></>}
  </>;
}
