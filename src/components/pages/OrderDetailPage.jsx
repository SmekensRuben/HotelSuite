import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import Modal from "../shared/Modal";
import DataListTable from "../shared/DataListTable";
import { useTranslation } from "react-i18next";
import { auth, db, doc, getDoc, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { deleteOrder, getOrderById, confirmOrder, reviewOrderDelivery } from "../../services/firebaseOrders";
import { getOutletApprovers } from "../../services/firebaseSettings";
import { getUserDisplayName } from "../../services/firebaseUserManagement";
import { getSupplier } from "../../services/firebaseSuppliers";
import { StickyNote } from "lucide-react";
import { usePermission } from "../../hooks/usePermission";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

function formatContent(item) {
  const amount = Number(item?.baseUnitsPerPurchaseUnit || 0);
  const unit = String(item?.baseUnit || "").trim();
  if (!(amount > 0) || !unit) return "-";
  return `${amount} ${unit}`;
}

export default function OrderDetailPage() {
  const canUpdateOrders = usePermission("orders", "update");
  const canDeleteOrders = usePermission("orders", "delete");
  const canApproveOrders = usePermission("orders", "approve");
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { orderId } = useParams();
  const { hotelUid, hotelName, isPlatformAdmin } = useHotelContext();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [createdByName, setCreatedByName] = useState("-");
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showOrderConfirmModal, setShowOrderConfirmModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ordering, setOrdering] = useState(false);
  const [supplierName, setSupplierName] = useState("-");
  const [pdfHotelName, setPdfHotelName] = useState("-");
  const [supplierOrderSystem, setSupplierOrderSystem] = useState("Email");
  const [actionError, setActionError] = useState("");
  const [confirmSubmitted, setConfirmSubmitted] = useState(false);
  const [confirmStartedAt, setConfirmStartedAt] = useState(0);
  const [progressMessage, setProgressMessage] = useState("");
  const [canConfirmOrder, setCanConfirmOrder] = useState(false);
  const [approverWarning, setApproverWarning] = useState("");
  const [openNoteRowId, setOpenNoteRowId] = useState("");
  const [recoveryEvidence, setRecoveryEvidence] = useState("");
  const [recoveryBusy, setRecoveryBusy] = useState(false);

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

  const refreshOrder = async () => {
    if (!hotelUid || !orderId) return null;
    const result = await getOrderById(hotelUid, orderId);
    setOrder(result);

    if (result?.createdBy) {
      setCreatedByName(await getUserDisplayName(result.createdBy));
    }

    if (result?.supplierId) {
      let supplier;
      try { supplier = await getSupplier(hotelUid, result.supplierId); }
      catch { supplier = { name: result.supplierName, orderSystem: result.dispatchedVia === "sftp" ? "SFTP csv" : "Supplier configuration" }; }
      setSupplierName(String(supplier?.name || "").trim() || result.supplierId);
      setSupplierOrderSystem(String(supplier?.orderSystem || "Email").trim() || "Email");
    } else {
      setSupplierName("-");
      setSupplierOrderSystem("Email");
    }

    if (hotelUid) {
      try {
        const hotelSnap = await getDoc(doc(db, `hotels/${hotelUid}`));
        const hotelData = hotelSnap.exists() ? hotelSnap.data() : null;
        const resolvedHotelName = String(hotelData?.hotelName || "").trim();
        setPdfHotelName(resolvedHotelName || hotelName || "-");
      } catch (error) {
        setPdfHotelName(hotelName || "-");
      }
    } else {
      setPdfHotelName(hotelName || "-");
    }

    const currentUid = String(auth.currentUser?.uid || "").trim();
    if (result?.outletId && currentUid) {
      const approvers = await getOutletApprovers(hotelUid, result.outletId);
      const isAllowed = approvers.some((approver) => String(approver.id || "").trim() === currentUid);
      setCanConfirmOrder(isAllowed && canApproveOrders);
      if (!canApproveOrders) {
        setApproverWarning("You do not have permission to approve orders.");
      } else if (!isAllowed) {
        setApproverWarning("Only outlet approvers can confirm this order.");
      } else {
        setApproverWarning("");
      }
    } else {
      setCanConfirmOrder(false);
      setApproverWarning("No outlet approvers configured for this order.");
    }

    return result;
  };

  useEffect(() => {
    const loadOrder = async () => {
      if (!hotelUid || !orderId) return;
      setLoading(true);
      try { await refreshOrder(); }
      catch (error) { setActionError(error.message || "Unable to load this order."); }
      finally { setLoading(false); }
    };

    loadOrder();
  }, [hotelUid, orderId, canApproveOrders]);

  useEffect(() => {
    if (!showOrderConfirmModal) return undefined;

    const interval = setInterval(async () => {
      let latestOrder;
      try { latestOrder = await refreshOrder(); }
      catch { setProgressMessage("Unable to refresh delivery. Reopen the order to check its status."); return; }
      const dispatchStatus = String(latestOrder?.dispatchStatus || "").toLowerCase();
      const latestStatus = String(latestOrder?.status || "");

      if (dispatchStatus === "sent") {
        setProgressMessage("Dispatch completed successfully.");
        clearInterval(interval);
        return;
      }

      if (dispatchStatus === "failed") {
        const details = String(latestOrder?.dispatchError || "").trim();
        setProgressMessage(
          details
            ? `Dispatch failed. Error: ${details}`
            : "Dispatch failed. Check supplier settings and try again."
        );
        clearInterval(interval);
        return;
      }

      if (["blocked", "needs-review"].includes(dispatchStatus)) {
        setProgressMessage("Delivery needs operator review. Check the provider before any recovery.");
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

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 text-gray-900">
        <HeaderBar today={today} onLogout={handleLogout} />
        <PageContainer>
          <p className="text-sm text-gray-600">Order laden...</p>
        </PageContainer>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="min-h-screen bg-gray-50 text-gray-900">
        <HeaderBar today={today} onLogout={handleLogout} />
        <PageContainer>
          <Card>
            <p className="text-sm text-gray-600">Order niet gevonden.</p>
          </Card>
        </PageContainer>
      </div>
    );
  }

  const isCreated = order.status === "Created" && !order.dispatchRequestId;
  const dispatchStatus = String(order.dispatchStatus || "").toLowerCase();
  const dispatchError = String(order.dispatchError || "").trim();
  const dispatchedVia = String(order.dispatchedVia || "").toLowerCase();
  const dispatchStep = String(order.dispatchStep || "").trim();
  const dispatchProgress = Number(order.dispatchProgress || 0);
  const expectedDeliveryMethod = supplierOrderSystem === "SFTP csv" ? "SFTP csv" : supplierOrderSystem === "Email" ? "Email" : "the supplier’s configured method";

  const items = Array.isArray(order.products) ? order.products : [];

  const rows = items.map((item, index) => {
    const unitPrice = Number(item.pricePerPurchaseUnit || 0);
    const qty = Number(item.qtyPurchaseUnits || 0);
    return {
      id: `${item.supplierProductId || "row"}-${index}`,
      supplierProductName: item.supplierProductName || "-",
      supplierSku: item.supplierSku || "-",
      purchaseUnit: item.purchaseUnit || "-",
      content: formatContent(item),
      qty,
      price: `${unitPrice.toFixed(2)} ${item.currency || order.currency || "EUR"}`,
      subtotal: `${(unitPrice * qty).toFixed(2)} ${item.currency || order.currency || "EUR"}`,
      note: String(item.note || "").trim(),
    };
  });

  const downloadOrderPdf = () => {
    const doc = new jsPDF();
    const outletName = String(order?.outletName || order?.outletId || "-").trim() || "-";

    doc.setFontSize(16);
    doc.text(`Order ${orderId}`, 14, 18);
    doc.setFontSize(11);
    doc.text(`Hotel: ${pdfHotelName || "-"}`, 14, 26);
    doc.text(`Outlet: ${outletName}`, 14, 32);
    doc.text(`Status: ${order.status || "-"}`, 14, 62);
    doc.text(`Supplier: ${supplierName || order.supplierId || "-"}`, 14, 38);
    doc.text(`Delivery Date: ${order.deliveryDate || "-"}`, 14, 44);
    doc.text(`Created By: ${createdByName || "-"}`, 14, 50);
    doc.text(`Total: ${Number(order.totalAmount || 0).toFixed(2)} ${order.currency || "EUR"}`, 14, 56);

    autoTable(doc, {
      startY: 64,
      head: [["Product", "SKU", "Purchase Unit", "Content", "Qty", "Received", "Price", "Subtotal"]],
      body: rows.map((row) => [
        row.supplierProductName,
        row.supplierSku,
        row.purchaseUnit,
        row.content,
        String(row.qty),
        "__________",
        row.price,
        row.subtotal,
      ]),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [31, 41, 55] },
    });

    const tableFinalY = doc.lastAutoTable?.finalY || 64;
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
    { key: "content", label: "Content" },
    { key: "qty", label: "Qty" },
    { key: "price", label: "Prijs" },
    { key: "subtotal", label: "Subtotaal" },
  ];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-3xl font-semibold">Order Detail</h1>
          <div className="flex items-center gap-2">
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
            <p><span className="font-semibold">Dispatch:</span> {dispatchStatus || "-"}</p>
            <p><span className="font-semibold">Supplier:</span> {supplierName || order.supplierId || "-"}</p>
            <p><span className="font-semibold">Delivery Date:</span> {order.deliveryDate || "-"}</p>
            <p><span className="font-semibold">Created By:</span> {createdByName}</p>
            <p><span className="font-semibold">Created At:</span> {order.createdAtDate ? new Date(order.createdAtDate).toLocaleString() : "-"}</p>
            <p><span className="font-semibold">Total:</span> {Number(order.totalAmount || 0).toFixed(2)} {order.currency || "EUR"}</p>
          </div>
        </Card>

        {actionError && <p className="text-sm text-red-600">{actionError}</p>}
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
              className="px-4 py-2 border border-green-300 text-green-700 rounded font-semibold hover:bg-green-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Confirm Order
            </button>
            </div>
          </div>
        )}
      </PageContainer>

      <Modal
        open={showOrderConfirmModal}
        onClose={closeConfirmModal}
        title="Confirm Order & Dispatch"
      >
        <div className="space-y-3 text-sm text-gray-700">
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

          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <p className="font-semibold text-gray-800">{t("orderConfirm.progress")}</p>
            {ordering && <p className="mt-1 text-blue-700">Starting dispatch request...</p>}
            {!ordering && confirmSubmitted && dispatchStatus === "processing" && (
              <p className="mt-1 text-amber-700">Dispatch is processing...</p>
            )}
            {!ordering && dispatchStatus === "sent" && (
              <p className="mt-1 text-green-700">
                Dispatch successful via {dispatchedVia === "sftp" ? "SFTP" : "email"}. Status is now Ordered.
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
                  className="h-full bg-blue-600 transition-all duration-300"
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
              setProgressMessage("Confirmation started. Waiting for dispatch result...");
              try {
                const key = `confirm-request:${hotelUid}:${orderId}`;
                let requestId = sessionStorage.getItem(key);
                if (!requestId) { requestId = crypto.randomUUID(); sessionStorage.setItem(key, requestId); }
                await confirmOrder(hotelUid, orderId, order.revision || 0, requestId);
                await refreshOrder();
              } catch (error) {
                setActionError(error?.message || "Could not confirm and dispatch order");
              } finally {
                setOrdering(false);
              }
            }}
            className="px-4 py-2 rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
          >
            {ordering || dispatchStatus === "processing" ? t("orderConfirm.confirming") : t("orderConfirm.confirm")}
          </button>
        </div>
      </Modal>

      {isPlatformAdmin && ["failed", "blocked", "needs-review", "processing"].includes(dispatchStatus) && <PageContainer>
        <Card>
          <h2 className="text-lg font-semibold">Delivery review</h2>
          <p className="mt-2 text-sm leading-6 text-gray-600">Check the email provider or supplier's SFTP receipt before recording delivery. An unconfirmed delivery cannot be resent. Preparation can be retried only when the backend confirms that no external send was attempted.</p>
          <label className="mt-4 block text-sm font-medium">Provider receipt or configuration review<textarea value={recoveryEvidence} onChange={(event) => setRecoveryEvidence(event.target.value)} maxLength={1000} className="mt-2 w-full rounded-lg border border-gray-300 p-3" /></label>
          <div className="mt-4 flex flex-wrap gap-3">{[["record-receipt", "Record verified delivery"], ["retry-preparation", "Retry preparation only"]].map(([action, label]) => <button key={action} disabled={recoveryBusy || !recoveryEvidence.trim()} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold disabled:opacity-50" onClick={async () => {
            setRecoveryBusy(true); setActionError("");
            try {
              await reviewOrderDelivery({ hotelUid, orderId, expectedRevision: order.revision || 0, requestId: crypto.randomUUID(), action, evidence: recoveryEvidence });
              await refreshOrder(); setRecoveryEvidence("");
            } catch (error) { setActionError(error.message || "This delivery needs operator review."); }
            finally { setRecoveryBusy(false); }
          }}>{label}</button>)}</div>
          {actionError && <p role="alert" className="mt-3 text-sm text-red-700">{actionError}</p>}
        </Card>
      </PageContainer>}

      <Modal open={showDeleteModal} onClose={() => setShowDeleteModal(false)} title="Delete order">
        <p className="text-sm text-gray-700">Are you sure you want to delete this order?</p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => setShowDeleteModal(false)} className="px-4 py-2 rounded border border-gray-300 text-gray-700">Cancel</button>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              if (!canDeleteOrders) return;
              await deleteOrder(hotelUid, orderId);
              setBusy(false);
              navigate("/orders");
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
