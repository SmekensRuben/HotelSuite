import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import Modal from "../shared/Modal";
import DataListTable from "../shared/DataListTable";
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
  const [actionError, setActionError] = useState("");

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

  useEffect(() => {
    const loadOrder = async () => {
      if (!hotelUid || !orderId) return;
      setLoading(true);
      const result = await getOrderById(hotelUid, orderId);
      setOrder(result);
      if (result?.createdBy) {
        setCreatedByName(await getUserDisplayName(result.createdBy));
      }
      if (result?.supplierId) {
        const supplier = await getSupplier(hotelUid, result.supplierId);
        setSupplierName(String(supplier?.name || "").trim() || result.supplierId);
      } else {
        setSupplierName("-");
      }
      setLoading(false);
    };

    loadOrder();
  }, [hotelUid, orderId]);

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
          <h1 className="text-3xl font-semibold">Order detail</h1>
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
                  onClick={() => {
                    setActionError("");
                    setShowOrderConfirmModal(true);
                  }}
                  className="px-4 py-2 border border-green-300 text-green-700 rounded font-semibold hover:bg-green-50"
                >
                  Mark as Ordered
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
              Terug
            </button>
          </div>
        </div>

        <Card>
          <div className="grid gap-3 md:grid-cols-3 text-sm">
            <p><span className="font-semibold">Status:</span> {order.status}</p>
            <p><span className="font-semibold">Supplier:</span> {supplierName || order.supplierId || "-"}</p>
            <p><span className="font-semibold">Delivery Date:</span> {order.deliveryDate || "-"}</p>
            <p><span className="font-semibold">Created By:</span> {createdByName}</p>
            <p><span className="font-semibold">Created At:</span> {order.createdAtDate ? new Date(order.createdAtDate).toLocaleString() : "-"}</p>
            <p><span className="font-semibold">Totaal:</span> {Number(order.totalAmount || 0).toFixed(2)} {order.currency || "EUR"}</p>
          </div>
        </Card>

        {actionError && <p className="text-sm text-red-600">{actionError}</p>}
        <DataListTable columns={columns} rows={rows} emptyMessage="Geen orderregels gevonden." />
      </PageContainer>


      <Modal open={showOrderConfirmModal} onClose={() => setShowOrderConfirmModal(false)} title="Order verzenden en status wijzigen">
        <p className="text-sm text-gray-700">
          Wil je deze order op status <span className="font-semibold">Ordered</span> zetten?
          De order wordt daarna automatisch verzonden op basis van het ingestelde order system van de supplier.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setShowOrderConfirmModal(false)}
            className="px-4 py-2 rounded border border-gray-300 text-gray-700"
          >
            Annuleer
          </button>
          <button
            type="button"
            disabled={ordering}
            onClick={async () => {
              setOrdering(true);
              setActionError("");
              try {
                const actor = auth.currentUser?.uid || auth.currentUser?.email || "unknown";
                await updateOrder(hotelUid, orderId, { status: "Ordered" }, actor);
                const refreshed = await getOrderById(hotelUid, orderId);
                setOrder(refreshed);
                setShowOrderConfirmModal(false);
              } catch (error) {
                setActionError(error?.message || "Kon order niet op Ordered zetten");
              } finally {
                setOrdering(false);
              }
            }}
            className="px-4 py-2 rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
          >
            {ordering ? "Bezig..." : "Bevestig"}
          </button>
        </div>
      </Modal>

      <Modal open={showDeleteModal} onClose={() => setShowDeleteModal(false)} title="Delete order">
        <p className="text-sm text-gray-700">Weet je zeker dat je deze order wil verwijderen?</p>
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
