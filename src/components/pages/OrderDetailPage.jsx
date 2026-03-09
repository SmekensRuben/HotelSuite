import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import Modal from "../shared/Modal";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { deleteOrder, getOrderById, updateOrder } from "../../services/firebaseOrders";
import { getUserDisplayName } from "../../services/firebaseUserManagement";

export default function OrderDetailPage() {
  const navigate = useNavigate();
  const { orderId } = useParams();
  const { hotelUid } = useHotelContext();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [createdByName, setCreatedByName] = useState("-");
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deliveryDate, setDeliveryDate] = useState("");
  const [editableItems, setEditableItems] = useState([]);
  const [busy, setBusy] = useState(false);

  const formatContent = (item) => {
    const amount = Number(item?.baseUnitsPerPurchaseUnit || 0);
    const unit = String(item?.baseUnit || "").trim();
    if (!(amount > 0) || !unit) return "-";
    return `${amount} ${unit}`;
  };

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

  const loadOrder = async () => {
    if (!hotelUid || !orderId) return;
    setLoading(true);
    const result = await getOrderById(hotelUid, orderId);
    setOrder(result);
    if (result?.createdBy) {
      const displayName = await getUserDisplayName(result.createdBy);
      setCreatedByName(displayName);
    }
    setDeliveryDate(result?.deliveryDate || "");
    setEditableItems(Array.isArray(result?.products) ? result.products : []);
    setLoading(false);
  };

  useEffect(() => {
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

  const items = Array.isArray(order.products) ? order.products : [];
  const isCreated = order.status === "Created";

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
                  onClick={() => setShowEditModal(true)}
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
              Terug
            </button>
          </div>
        </div>

        <Card>
          <div className="grid gap-3 md:grid-cols-3 text-sm">
            <p>
              <span className="font-semibold">Status:</span> {order.status}
            </p>
            <p>
              <span className="font-semibold">Supplier:</span> {order.supplierId || "-"}
            </p>
            <p>
              <span className="font-semibold">Delivery Date:</span> {order.deliveryDate || "-"}
            </p>
            <p>
              <span className="font-semibold">Created By:</span> {createdByName}
            </p>
            <p>
              <span className="font-semibold">Created At:</span>{" "}
              {order.createdAtDate ? new Date(order.createdAtDate).toLocaleString() : "-"}
            </p>
            <p>
              <span className="font-semibold">Totaal:</span> {Number(order.totalAmount || 0).toFixed(2)}{" "}
              {order.currency || "EUR"}
            </p>
          </div>
        </Card>

        <Card>
          <h2 className="text-lg font-semibold mb-3">Orderregels</h2>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                    Product
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                    SKU
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                    Purchase Unit
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                    Content
                  </th>
                  <th className="px-4 py-2 text-right text-xs font-semibold uppercase text-gray-500">
                    Qty
                  </th>
                  <th className="px-4 py-2 text-right text-xs font-semibold uppercase text-gray-500">
                    Prijs
                  </th>
                  <th className="px-4 py-2 text-right text-xs font-semibold uppercase text-gray-500">
                    Subtotaal
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map((item) => {
                  const unitPrice = Number(item.pricePerPurchaseUnit || 0);
                  const qty = Number(item.qtyPurchaseUnits || 0);
                  return (
                    <tr key={`${item.supplierProductId}_${item.variantId || ""}`}>
                      <td className="px-4 py-2 text-sm">{item.supplierProductName || "-"}</td>
                      <td className="px-4 py-2 text-sm">{item.supplierSku || "-"}</td>
                      <td className="px-4 py-2 text-sm">{item.purchaseUnit || "-"}</td>
                      <td className="px-4 py-2 text-sm">{formatContent(item)}</td>
                      <td className="px-4 py-2 text-sm text-right">{qty}</td>
                      <td className="px-4 py-2 text-sm text-right">
                        {unitPrice.toFixed(2)} {item.currency || order.currency || "EUR"}
                      </td>
                      <td className="px-4 py-2 text-sm text-right">
                        {(unitPrice * qty).toFixed(2)} {item.currency || order.currency || "EUR"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </PageContainer>

      <Modal open={showEditModal} onClose={() => setShowEditModal(false)} title="Edit order">
        <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
          Delivery Date
          <input
            type="date"
            value={deliveryDate}
            onChange={(event) => setDeliveryDate(event.target.value)}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </label>

        <div className="mt-4">
          <p className="text-sm font-semibold text-gray-700 mb-2">Orderregels</p>
          {editableItems.length === 0 ? (
            <p className="text-sm text-gray-500">Geen orderregels meer.</p>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
              {editableItems.map((item, index) => (
                <div key={`${item.supplierProductId || "row"}_${index}`} className="rounded border border-gray-200 p-2">
                  <p className="text-sm font-semibold text-gray-800">{item.supplierProductName || "-"}</p>
                  <p className="text-xs text-gray-500">{item.supplierSku || "-"} · {formatContent(item)}</p>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <input
                      type="number"
                      min="1"
                      value={Number(item.qtyPurchaseUnits || 1)}
                      onChange={(event) => {
                        const nextQty = Math.max(1, Number(event.target.value || 1));
                        setEditableItems((prev) => prev.map((entry, i) => (i === index ? { ...entry, qtyPurchaseUnits: nextQty } : entry)));
                      }}
                      className="w-24 rounded border border-gray-300 px-2 py-1 text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => setEditableItems((prev) => prev.filter((_, i) => i !== index))}
                      className="text-xs font-semibold text-red-700 hover:text-red-900"
                    >
                      Verwijder regel
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setShowEditModal(false)}
            className="px-4 py-2 rounded border border-gray-300 text-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!deliveryDate || busy}
            onClick={async () => {
              if (!deliveryDate || editableItems.length === 0) return;
              setBusy(true);
              const actor = auth.currentUser?.uid || auth.currentUser?.email || "unknown";
              await updateOrder(hotelUid, orderId, { deliveryDate, products: editableItems }, actor);
              setBusy(false);
              setShowEditModal(false);
              await loadOrder();
            }}
            className="px-4 py-2 rounded bg-[#b41f1f] text-white hover:bg-[#961919] disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </Modal>

      <Modal open={showDeleteModal} onClose={() => setShowDeleteModal(false)} title="Delete order">
        <p className="text-sm text-gray-700">Weet je zeker dat je deze order wil verwijderen?</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setShowDeleteModal(false)}
            className="px-4 py-2 rounded border border-gray-300 text-gray-700"
          >
            Cancel
          </button>
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
