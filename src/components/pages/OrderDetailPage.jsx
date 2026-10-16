import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import { Card } from "../layout/Card";
import Modal from "../shared/Modal";
import DataListTable from "../shared/DataListTable";
import { frozenStockContent } from "../orders/orderInventoryDisplay";
import { useTranslation } from "react-i18next";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { deleteOrder, getOrderById, confirmOrder } from "../../services/firebaseOrders";
import { getOutletApprovers } from "../../services/firebaseSettings";
import AsyncError from "../shared/AsyncError";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { useStaffDisplayNames } from "../../hooks/useStaffDisplayNames";
import { getSupplier } from "../../services/firebaseSuppliers";
import { StickyNote } from "lucide-react";
import { usePermission } from "../../hooks/usePermission";
import OrderDeliveryPanel from "../orders/OrderDeliveryPanel";
import OrderReceivingPanel from "../orders/OrderReceivingPanel";
import SupplierConfirmationPanel from "../orders/SupplierConfirmationPanel";
import { formatOrderMoney, formatOrderSubtotal, formatOrderPriceBasis } from "../../utils/orderPricing";
import { orderPriceReliability, orderPriceSource, orderPriceEvidence } from "../../utils/orderPriceReliability";

function formatContent(item) {
  const amount = Number(item?.baseUnitsPerPurchaseUnit || 0);
  const unit = String(item?.baseUnit || "").trim();
  if (!(amount > 0) || !unit) return "-";
  return `${amount} ${unit}`;
}

export default function OrderDetailPage() {
  const { orderId } = useParams();
  const { hotelUid, hotelName, isPlatformAdmin } = useHotelContext();
  return <ScopedOrderDetail key={`${hotelUid}:${orderId}`} hotelUid={hotelUid} hotelName={hotelName} isPlatformAdmin={isPlatformAdmin} orderId={orderId} />;
}

function ScopedOrderDetail({ hotelUid, hotelName, isPlatformAdmin, orderId }) {
  const canUpdateOrders = usePermission("orders", "update");
  const canDeleteOrders = usePermission("orders", "delete");
  const canApproveOrders = usePermission("orders", "approve");
  const { t } = useTranslation();
  const navigate = useNavigate();
  const scopeKey = `${hotelUid}:${orderId}`;
  const load = useCallback(() => getOrderById(hotelUid, orderId), [hotelUid, orderId]);
  const query = useScopedAsync({ scopeKey, enabled: Boolean(hotelUid && orderId), retainData: true, load });
  const order = query.data;
  const loading = query.loading;
  const refreshOrder = query.run;
  const { createdByName, updatedByName } = useStaffDisplayNames({ hotelUid, scopeKey, record: order });
  const canReadSuppliers = usePermission("suppliers", "read");
  const supplierId = order?.supplierId || "";
  const loadSupplier = useCallback(() => getSupplier(hotelUid, supplierId), [hotelUid, supplierId]);
  const supplierQuery = useScopedAsync({ scopeKey: `${scopeKey}:${supplierId}:${canReadSuppliers}`, enabled: Boolean(hotelUid && supplierId && canReadSuppliers), load: loadSupplier });
  const supplierName = supplierQuery.data?.name || order?.supplierName || supplierId || "-";
  const supplierOrderSystem = supplierQuery.data?.orderSystem || (order?.dispatchedVia === "sftp" ? "SFTP csv" : "Supplier configuration");
  const pdfHotelName = hotelName || "-";
  const outletId = order?.outletId || "";
  const currentUid = auth.currentUser?.uid || "";
  const loadApprovers = useCallback(() => getOutletApprovers(hotelUid, outletId), [hotelUid, outletId]);
  const approvalQuery = useScopedAsync({ scopeKey: `${scopeKey}:${outletId}:${currentUid}:${canApproveOrders}`, enabled: Boolean(hotelUid && outletId && currentUid && canApproveOrders), load: loadApprovers });
  const canConfirmOrder = canApproveOrders && Boolean(approvalQuery.data?.some((approver) => approver.id === currentUid));
  const approverWarning = !canApproveOrders ? "You do not have permission to approve orders." : !outletId || !currentUid ? "No outlet approvers configured for this order." : approvalQuery.loading ? "Checking outlet approval..." : !canConfirmOrder ? "Only outlet approvers can confirm this order." : "";
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showOrderConfirmModal, setShowOrderConfirmModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ordering, setOrdering] = useState(false);
  const [actionError, setActionError] = useState("");
  const [confirmSubmitted, setConfirmSubmitted] = useState(false);
  const [confirmStartedAt, setConfirmStartedAt] = useState(0);
  const [progressMessage, setProgressMessage] = useState("");
  const [openNoteRowId, setOpenNoteRowId] = useState("");

  const today = useMemo(
    () =>
      new Date().toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
    []
  );

  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  const closeConfirmModal = () => {
    // Delivery continues independently of the browser and the confirmation dialog.
    setShowOrderConfirmModal(false);
  };

  useEffect(() => {
    if (!showOrderConfirmModal) return undefined;

    const interval = setInterval(async () => {
      const latestOrder = await refreshOrder();
      if (!mounted.current) return;
      if (!latestOrder) { setProgressMessage("Unable to refresh delivery. Reopen the order to check its status."); return; }
      const dispatchStatus = String(latestOrder?.dispatchStatus || "").toLowerCase();

      if (dispatchStatus === "sent") {
        setProgressMessage(latestOrder.dispatchMode === "simulation" ? "Demo confirmation completed; no supplier was contacted." : "Dispatch completed. Supplier acceptance is tracked separately.");
        clearInterval(interval);
        return;
      }

      if (dispatchStatus === "failed") {
        const details = String(latestOrder?.dispatchError || "").trim();
        setProgressMessage(
          details
            ? `Dispatch failed. Error: ${details}`
            : "Preparation failed. A delivery recovery manager must review the configuration before a safe retry."
        );
        clearInterval(interval);
        return;
      }

      if (["blocked", "needs-review"].includes(dispatchStatus)) {
        setProgressMessage("Delivery needs review. Open Delivery review on this order and check transport evidence before recovery.");
        clearInterval(interval);
        return;
      }
      const elapsedMs = confirmStartedAt > 0 ? Date.now() - confirmStartedAt : 0;
      if (confirmSubmitted && elapsedMs > 30000 && ["pending", "processing"].includes(dispatchStatus)) {
        setProgressMessage("Delivery is still running. You can close this dialog and check the order later.");
      }
    }, 2500);

    return () => clearInterval(interval);
  }, [showOrderConfirmModal, hotelUid, orderId, confirmSubmitted, confirmStartedAt]);

  if (loading && !order) {
    return (
      <div className="min-h-screen bg-canvas text-gray-900">
        <HeaderBar today={today} onLogout={handleLogout} />
        <ProcurementPage>
          <p role="status" className="text-sm text-gray-600">Loading order...</p>
        </ProcurementPage>
      </div>
    );
  }

  if (query.error && !order) return <div className="min-h-screen bg-canvas text-gray-900"><HeaderBar today={today} onLogout={handleLogout} /><ProcurementPage><AsyncError error={query.error} onRetry={query.retry} label="Could not load this order." /></ProcurementPage></div>;

  if (!order) {
    return (
      <div className="min-h-screen bg-canvas text-gray-900">
        <HeaderBar today={today} onLogout={handleLogout} />
        <ProcurementPage>
          <Card>
            <p className="text-sm text-gray-600">Order not found.</p>
          </Card>
        </ProcurementPage>
      </div>
    );
  }

  const isSimulation = order.dispatchMode === "simulation";
  const isCreated = order.status === "Created" && !order.dispatchRequestId;
  const dispatchStatus = String(order.dispatchStatus || "").toLowerCase();
  const dispatchError = String(order.dispatchError || "").trim();
  const dispatchedVia = String(order.dispatchedVia || "").toLowerCase();
  const dispatchStep = String(order.dispatchStep || "").trim();
  const dispatchProgress = Number(order.dispatchProgress || 0);
  const expectedDeliveryMethod = supplierOrderSystem === "SFTP csv" ? "SFTP csv" : supplierOrderSystem === "Email" ? "Email" : "the supplier’s configured method";

  const items = Array.isArray(order.products) ? order.products : [];

  const rows = items.map((item, index) => {
    const unitPrice = item.pricePerPurchaseUnit;
    const qty = Number(item.qtyPurchaseUnits || 0);
    return {
      id: `${item.supplierProductId || "row"}-${index}`,
      supplierProductName: item.supplierProductName || "-",
      supplierSku: item.supplierSku || "-",
      purchaseUnit: item.purchaseUnit || "-",
      content: formatContent(item),
      stockContent: frozenStockContent(item),
      qty,
      price: formatOrderMoney(unitPrice, item.currency || order.currency),
      priceBasisLabel: formatOrderPriceBasis(item.priceBasis),
      priceReliability: orderPriceReliability(item), priceSource: orderPriceSource(item), priceEvidence: orderPriceEvidence(item),
      subtotal: formatOrderSubtotal(unitPrice, item.qtyPurchaseUnits, item.currency || order.currency),
      note: String(item.note || "").trim(),
    };
  });

  const downloadOrderPdf = async () => {
    const [{ jsPDF }, { default: autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
    if (!mounted.current) return;
    const doc = new jsPDF();
    const outletName = String(order?.outletName || order?.outletId || "-").trim() || "-";

    doc.setFontSize(16);
    doc.text(isSimulation ? `DEMO Order ${orderId} (simulation)` : `Order ${orderId}`, 14, 18);
    doc.setFontSize(11);
    doc.text(`Hotel: ${pdfHotelName || "-"}`, 14, 26);
    doc.text(`Outlet: ${outletName}`, 14, 32);
    doc.text(`Status: ${order.status || "-"}`, 14, 68);
    doc.text(`Supplier: ${supplierName || order.supplierId || "-"}`, 14, 38);
    doc.text(`Delivery Date: ${order.deliveryDate || "-"}`, 14, 44);
    doc.text(`Created By: ${createdByName || "-"}`, 14, 50);
    doc.text(`Price basis: ${formatOrderPriceBasis(order.priceBasis)}`, 14, 62);
    doc.text(`Quoted total: ${formatOrderMoney(order.totalAmount, order.currency)}`, 14, 56);

    autoTable(doc, {
      startY: 72,
      head: [["Product", "SKU", "Purchase Unit", "Content", "Qty", "Received", "Package price", "Price basis", "Quoted subtotal"]],
      body: rows.map((row) => [
        row.supplierProductName,
        row.supplierSku,
        row.purchaseUnit,
        row.content,
        String(row.qty),
        "__________",
        row.price,
        row.priceBasisLabel,
        row.subtotal,
      ]),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [31, 41, 55] },
    });

    const tableFinalY = doc.lastAutoTable?.finalY || 72;
    const signatureStartY = tableFinalY + 22;

    doc.setFontSize(10);
    doc.text("Receiver name:", 14, signatureStartY);
    doc.line(48, signatureStartY, 100, signatureStartY);
    doc.text("Receiver signature:", 112, signatureStartY);
    doc.line(162, signatureStartY, 196, signatureStartY);

    const secondLineY = signatureStartY + 16;
    doc.text("Manager name:", 14, secondLineY);
    doc.line(46, secondLineY, 100, secondLineY);
    doc.text("Manager signature:", 112, secondLineY);
    doc.line(162, secondLineY, 196, secondLineY);

    doc.save(`order-${orderId}.pdf`);
  };

  const columns = [
    {
      key: "supplierProductName",
      label: "Product",
      render: (row) => (
        <div className="flex items-start gap-2">
          {row.note ? (
            <button
              type="button"
              onClick={() => setOpenNoteRowId((current) => (current === row.id ? "" : row.id))}
              className="mt-0.5 rounded text-amber-500 hover:text-amber-600"
              aria-label={`Show note for ${row.supplierProductName}`}
              title="Show note"
            >
              <StickyNote className="h-4 w-4 shrink-0" />
            </button>
          ) : null}
          <div className="min-w-0">
            <span>{row.supplierProductName}</span>
            {openNoteRowId === row.id && row.note ? (
              <p className="mt-1 text-xs text-gray-600">{row.note}</p>
            ) : null}
          </div>
        </div>
      ),
    },
    { key: "supplierSku", label: "SKU" },
    { key: "purchaseUnit", label: "Purchase Unit" },
    { key: "content", label: "Package content", render: (row) => <div><p>{row.content}</p><p className="mt-1 max-w-[15rem] text-xs text-slate-500">{row.stockContent}</p></div> },
    { key: "qty", label: "Qty" },
    { key: "price", label: "Package price", render: (row) => <div><p>{row.price}</p><p className="mt-1 max-w-[18rem] text-xs text-slate-600">{row.priceReliability}</p><p className="mt-1 max-w-[18rem] break-words text-xs text-slate-500">{row.priceSource}</p><p className="mt-1 max-w-[18rem] text-xs text-slate-500">{row.priceEvidence}</p></div> },
    { key: "priceBasisLabel", label: "Price basis" },
    { key: "subtotal", label: "Quoted subtotal" },
  ];

  return (
    <div className="min-h-screen bg-canvas text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <ProcurementPage className="space-y-6">
        <AsyncError error={query.error} onRetry={query.retry} label="Could not refresh this order." />
        {canReadSuppliers && <AsyncError error={supplierQuery.error} onRetry={supplierQuery.retry} label="Could not load supplier details. Saved order names remain available." />}
        {canApproveOrders && <AsyncError error={approvalQuery.error} onRetry={approvalQuery.retry} label="Could not verify outlet approval." />}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-3xl font-semibold">Order Detail</h1>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={downloadOrderPdf}
              className="px-4 py-2 border border-gray-300 rounded font-semibold hover:bg-gray-100"
            >
              Download PDF
            </button>
            {isCreated && (
              <>
                {canUpdateOrders && <button
                  type="button"
                  onClick={() => navigate(`/orders/${orderId}/edit`)}
                  className="px-4 py-2 border border-gray-300 rounded font-semibold hover:bg-gray-100"
                >
                  Edit
                </button>}
                {canDeleteOrders && <button
                  type="button"
                  onClick={() => setShowDeleteModal(true)}
                  className="px-4 py-2 border border-red-300 text-red-700 rounded font-semibold hover:bg-red-50"
                >
                  Delete
                </button>}
              </>
            )}
            <button
              type="button"
              onClick={() => navigate("/orders")}
              className="px-4 py-2 border border-gray-300 rounded font-semibold hover:bg-gray-100"
            >
              Back
            </button>
          </div>
        </div>

        <Card>
          <div className="grid gap-3 md:grid-cols-3 text-sm">
            <p><span className="font-semibold">Status:</span> {order.status}</p>
            <p><span className="font-semibold">Price basis:</span> {formatOrderPriceBasis(order.priceBasis)}</p>
            <p><span className="font-semibold">Dispatch:</span> {dispatchStatus || "-"}</p>
            <p><span className="font-semibold">Supplier:</span> {supplierName || order.supplierId || "-"}</p>
            <p><span className="font-semibold">Delivery Date:</span> {order.deliveryDate || "-"}</p>
            <p><span className="font-semibold">Created By:</span> {createdByName}</p>
            <p><span className="font-semibold">Updated By:</span> {updatedByName}</p>
            <p><span className="font-semibold">Created At:</span> {order.createdAtDate ? new Date(order.createdAtDate).toLocaleString() : "-"}</p>
            <p><span className="font-semibold">Quoted total:</span> {formatOrderMoney(order.totalAmount, order.currency)}</p>
          </div>
        </Card>

        {order.dispatchMode === "simulation" && <p role="status" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm">DEMO order: supplier delivery is simulated. No email or SFTP file is sent. Receiving and stock-count actions still use the normal hotel permissions.</p>}
        {actionError && <p className="text-sm text-red-600">{actionError}</p>}
        <p className="text-xs text-gray-600">Quoted amounts are shown as recorded. No VAT conversion is applied; missing historical price bases remain unknown.</p>
        <DataListTable columns={columns} rows={rows} emptyMessage="No order lines found." />

        {isCreated && (
          <div className="space-y-2">
            {approverWarning && <p className="text-sm text-amber-700">{approverWarning}</p>}
            <div className="flex justify-end">
            <button
              type="button"
              onClick={() => {
                setActionError("");
                setConfirmSubmitted(false);
                setConfirmStartedAt(0);
                setProgressMessage("");
                setShowOrderConfirmModal(true);
              }}
              disabled={!canConfirmOrder}
              className="px-4 py-2 border border-brand-300 text-brand-800 rounded font-semibold hover:bg-brand-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSimulation ? "Confirm simulated order" : "Confirm Order"}
            </button>
            </div>
          </div>
        )}
        {order.dispatchRequestId && <OrderDeliveryPanel hotelUid={hotelUid} orderId={orderId} orderRevision={order.revision} onChanged={refreshOrder} isPlatformAdmin={isPlatformAdmin} disabled={loading || Boolean(query.error)} />}
        {["Ordered", "Received", "Finalized"].includes(order.status) && <SupplierConfirmationPanel hotelUid={hotelUid} orderId={orderId} orderRevision={order.revision} onChanged={refreshOrder} disabled={loading || Boolean(query.error)} />}
        {["Ordered", "Received", "Finalized"].includes(order.status) && <OrderReceivingPanel hotelUid={hotelUid} orderId={orderId} orderRevision={order.revision} onChanged={refreshOrder} disabled={loading || Boolean(query.error)} />}
      </ProcurementPage>

      <Modal
        open={showOrderConfirmModal}
        onClose={closeConfirmModal}
        title={isSimulation ? "Confirm simulated order" : "Confirm Order & Dispatch"}
      >
        <AsyncError error={query.error} onRetry={query.retry} label="Could not refresh this order." />
        <div className="space-y-3 text-sm text-gray-700">
          {isSimulation ? <p>Confirm this test order using the normal approver checks. Delivery is simulated; no supplier email or SFTP file is sent.</p> : <>
          <p>
            {t("orderConfirm.description1", {
              supplier: supplierName || order.supplierId || "supplier",
            })}
          </p>
          <p>
            {t("orderConfirm.description2")} <span className="font-semibold">{expectedDeliveryMethod}</span>.
          </p>
          <p>
            {t("orderConfirm.description3")}
          </p>
          </>}

          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <p className="font-semibold text-gray-800">{t("orderConfirm.progress")}</p>
            {ordering && <p className="mt-1 text-brand-800">Starting dispatch request...</p>}
            {!ordering && confirmSubmitted && dispatchStatus === "processing" && (
              <p className="mt-1 text-amber-700">Dispatch is processing...</p>
            )}
            {!ordering && dispatchStatus === "sent" && (
              <p className="mt-1 text-green-700">
                {isSimulation ? "Demo confirmation successful. No supplier was contacted. Status is now Ordered." : <>Dispatch successful via {dispatchedVia === "sftp" ? "SFTP" : "email"}. Status is now Ordered; supplier acceptance is tracked separately.</>}
              </p>
            )}
            {!ordering && dispatchStatus === "failed" && (
              <p className="mt-1 text-red-700">
                Dispatch failed{dispatchError ? `: ${dispatchError}` : "."}
              </p>
            )}
            {!ordering && !confirmSubmitted && order.status === "Created" && (
              <p className="mt-1 text-gray-600">Not confirmed yet.</p>
            )}
            {dispatchStep && <p className="mt-1 text-xs text-gray-500">Step: {dispatchStep}</p>}

            <div className="mt-2">
              <div className="h-2 w-full rounded bg-gray-200 overflow-hidden">
                <div
                  className="h-full bg-brand-800 transition-all duration-300"
                  style={{ width: `${Math.max(0, Math.min(100, dispatchProgress))}%` }}
                />
              </div>
              <p className="mt-1 text-xs text-gray-500">{Math.max(0, Math.min(100, dispatchProgress))}%</p>
            </div>

            {progressMessage && <p className="mt-1 text-sm text-gray-700">{progressMessage}</p>}
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={closeConfirmModal}
            className="px-4 py-2 rounded border border-gray-300 text-gray-700"
          >
            {t("orderConfirm.close")}
          </button>
          <button
            type="button"
            disabled={ordering || order.status !== "Created" || Boolean(order.dispatchRequestId) || !canConfirmOrder}
            onClick={async () => {
              setOrdering(true);
              setActionError("");
              setConfirmSubmitted(true);
              setConfirmStartedAt(Date.now());
              setProgressMessage(isSimulation ? "Confirmation started. Simulating delivery..." : "Confirmation started. Waiting for dispatch result...");
              try {
                const key = `confirm-request:${hotelUid}:${orderId}`;
                let requestId = sessionStorage.getItem(key);
                if (!requestId) { requestId = crypto.randomUUID(); sessionStorage.setItem(key, requestId); }
                await confirmOrder(hotelUid, orderId, order.revision || 0, requestId);
                if (mounted.current) await refreshOrder();
              } catch (error) {
                if (mounted.current) setActionError(error?.message || "Could not confirm and dispatch order");
              } finally {
                if (mounted.current) setOrdering(false);
              }
            }}
            className="px-4 py-2 rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
          >
            {ordering || dispatchStatus === "processing" ? t("orderConfirm.confirming") : isSimulation ? "Confirm simulation" : t("orderConfirm.confirm")}
          </button>
        </div>
      </Modal>


      <Modal open={showDeleteModal} onClose={() => setShowDeleteModal(false)} title="Delete order">
        <p className="text-sm text-gray-700">Are you sure you want to delete this order?</p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => setShowDeleteModal(false)} className="px-4 py-2 rounded border border-gray-300 text-gray-700">Cancel</button>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              if (!canDeleteOrders) return;
              setBusy(true);
              try {
                await deleteOrder(hotelUid, orderId);
                if (mounted.current) navigate("/orders");
              } catch (error) { if (mounted.current) setActionError(error.message || "Could not delete this order."); }
              finally { if (mounted.current) setBusy(false); }
            }}
            className="px-4 py-2 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      </Modal>
    </div>
  );
}
