import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import Modal from "../shared/Modal";
import DataListTable from "../shared/DataListTable";
import { useTranslation } from "react-i18next";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { deleteOrder, getOrderById, updateOrder } from "../../services/firebaseOrders";
import { getUserDisplayName } from "../../services/firebaseUserManagement";
import { getSupplier } from "../../services/firebaseSuppliers";

function formatContent(item) {
  const amount = Number(item?.baseUnitsPerPurchaseUnit || 0);
  const unit = String(item?.baseUnit || "").trim();
  if (!(amount > 0) || !unit) return "-";
  return `${amount} ${unit}`;
}

export default function OrderDetailPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { orderId } = useParams();
  const { hotelUid } = useHotelContext();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [createdByName, setCreatedByName] = useState("-");
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showOrderConfirmModal, setShowOrderConfirmModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ordering, setOrdering] = useState(false);
  const [supplierName, setSupplierName] = useState("-");
  const [supplierOrderSystem, setSupplierOrderSystem] = useState("Email");
  const [actionError, setActionError] = useState("");
  const [confirmSubmitted, setConfirmSubmitted] = useState(false);
  const [confirmStartedAt, setConfirmStartedAt] = useState(0);
  const [progressMessage, setProgressMessage] = useState("");

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

  const closeConfirmModal = async () => {
    if ((dispatchStatus === "processing" || ordering) && String(order?.status || "") === "Created") {
      try {
        const actor = auth.currentUser?.uid || auth.currentUser?.email || "unknown";
        await updateOrder(
          hotelUid,
          orderId,
          {
            dispatchStatus: "failed",
            dispatchProgress: 100,
            dispatchStep: "Dispatch cancelled by user (modal closed)",
            dispatchError: "Dispatch cancelled because confirmation modal was closed while processing",
            dispatchRequestId: "",
          },
          actor
        );
        await refreshOrder();
      } catch (error) {
        setActionError(error?.message || "Could not update dispatch status when closing modal");
      }
    }

    setShowOrderConfirmModal(false);
    setConfirmSubmitted(false);
    setConfirmStartedAt(0);
    setProgressMessage("");
  };

  const refreshOrder = async () => {
    if (!hotelUid || !orderId) return null;
    const result = await getOrderById(hotelUid, orderId);
    setOrder(result);

    if (result?.createdBy) {
      setCreatedByName(await getUserDisplayName(result.createdBy));
    }

    if (result?.supplierId) {
      const supplier = await getSupplier(hotelUid, result.supplierId);
      setSupplierName(String(supplier?.name || "").trim() || result.supplierId);
      setSupplierOrderSystem(String(supplier?.orderSystem || "Email").trim() || "Email");
    } else {
      setSupplierName("-");
      setSupplierOrderSystem("Email");
    }

    return result;
  };

  useEffect(() => {
    const loadOrder = async () => {
      if (!hotelUid || !orderId) return;
      setLoading(true);
      await refreshOrder();
      setLoading(false);
    };

    loadOrder();
  }, [hotelUid, orderId]);

  useEffect(() => {
    if (!showOrderConfirmModal) return undefined;

    const interval = setInterval(async () => {
      const latestOrder = await refreshOrder();
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

      if (confirmSubmitted && latestStatus === "Created" && dispatchStatus === "failed") {
        const details = String(latestOrder?.dispatchError || "").trim();
        setProgressMessage(
          details
            ? `Order stayed in Created because dispatch failed: ${details}`
            : "Order stayed in Created because dispatch did not succeed."
        );
      }

      const elapsedMs = confirmStartedAt > 0 ? Date.now() - confirmStartedAt : 0;
      if (confirmSubmitted && elapsedMs > 30000 && dispatchStatus === "processing") {
        const actor = auth.currentUser?.uid || auth.currentUser?.email || "unknown";
        await updateOrder(
          hotelUid,
          orderId,
          {
            dispatchStatus: "failed",
            dispatchProgress: 100,
            dispatchStep: "Dispatch timeout after 30 seconds",
            dispatchError: "Dispatch timed out after 30 seconds",
            dispatchRequestId: "",
          },
          actor
        );
        setProgressMessage("Dispatch was automatically failed after 30 seconds without a result.");
        clearInterval(interval);
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

  const isCreated = order.status === "Created";
  const dispatchStatus = String(order.dispatchStatus || "").toLowerCase();
  const dispatchError = String(order.dispatchError || "").trim();
  const dispatchedVia = String(order.dispatchedVia || "").toLowerCase();
  const dispatchStep = String(order.dispatchStep || "").trim();
  const dispatchProgress = Number(order.dispatchProgress || 0);
  const expectedDeliveryMethod = supplierOrderSystem === "SFTP csv" ? "SFTP csv" : "Email";

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
    };
  });

  const columns = [
    { key: "supplierProductName", label: "Product" },
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
            {isCreated && (
              <>
                <button
                  type="button"
                  onClick={() => navigate(`/orders/${orderId}/edit`)}
                  className="px-4 py-2 border border-gray-300 rounded font-semibold hover:bg-gray-100"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => setShowDeleteModal(true)}
                  className="px-4 py-2 border border-red-300 text-red-700 rounded font-semibold hover:bg-red-50"
                >
                  Delete
                </button>
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
              className="px-4 py-2 border border-green-300 text-green-700 rounded font-semibold hover:bg-green-50"
            >
              Confirm Order
            </button>
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
            disabled={ordering || order.status !== "Created" || dispatchStatus === "processing"}
            onClick={async () => {
              setOrdering(true);
              setActionError("");
              setConfirmSubmitted(true);
              setConfirmStartedAt(Date.now());
              setProgressMessage("Confirmation started. Waiting for dispatch result...");
              try {
                const actor = auth.currentUser?.uid || auth.currentUser?.email || "unknown";
                await updateOrder(
                  hotelUid,
                  orderId,
                  {
                    dispatchRequestId: `${Date.now()}`,
                    dispatchStatus: "processing",
                    dispatchProgress: 5,
                    dispatchStep: "Dispatch requested",
                    dispatchError: "",
                  },
                  actor
                );
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

      <Modal open={showDeleteModal} onClose={() => setShowDeleteModal(false)} title="Delete order">
        <p className="text-sm text-gray-700">Are you sure you want to delete this order?</p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => setShowDeleteModal(false)} className="px-4 py-2 rounded border border-gray-300 text-gray-700">Cancel</button>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
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
