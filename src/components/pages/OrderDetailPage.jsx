import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getOrderById } from "../../services/firebaseOrders";
import { getUserDisplayName } from "../../services/firebaseUserManagement";

export default function OrderDetailPage() {
  const navigate = useNavigate();
  const { orderId } = useParams();
  const { hotelUid } = useHotelContext();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [createdByName, setCreatedByName] = useState("-");

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
    const load = async () => {
      if (!hotelUid || !orderId) return;
      setLoading(true);
      const result = await getOrderById(hotelUid, orderId);
      setOrder(result);
      if (result?.createdBy) {
        const displayName = await getUserDisplayName(result.createdBy);
        setCreatedByName(displayName);
      }
      setLoading(false);
    };

    load();
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

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-3xl font-semibold">Order detail</h1>
          <button type="button" onClick={() => navigate("/orders")} className="px-4 py-2 border border-gray-300 rounded font-semibold hover:bg-gray-100">
            Terug
          </button>
        </div>

        <Card>
          <div className="grid gap-3 md:grid-cols-3 text-sm">
            <p><span className="font-semibold">Status:</span> {order.status}</p>
            <p><span className="font-semibold">Supplier:</span> {order.supplierId || "-"}</p>
            <p><span className="font-semibold">Delivery Date:</span> {order.deliveryDate || "-"}</p>
            <p><span className="font-semibold">Created By:</span> {createdByName}</p>
            <p><span className="font-semibold">Created At:</span> {order.createdAtDate ? new Date(order.createdAtDate).toLocaleString() : "-"}</p>
            <p><span className="font-semibold">Totaal:</span> {Number(order.totalAmount || 0).toFixed(2)} {order.currency || "EUR"}</p>
          </div>
        </Card>

        <Card>
          <h2 className="text-lg font-semibold mb-3">Orderregels</h2>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-semibold uppercase text-gray-500">Product</th>
                  <th className="px-4 py-2 text-left text-xs font-semibold uppercase text-gray-500">SKU</th>
                  <th className="px-4 py-2 text-left text-xs font-semibold uppercase text-gray-500">Purchase Unit</th>
                  <th className="px-4 py-2 text-right text-xs font-semibold uppercase text-gray-500">Qty</th>
                  <th className="px-4 py-2 text-right text-xs font-semibold uppercase text-gray-500">Prijs</th>
                  <th className="px-4 py-2 text-right text-xs font-semibold uppercase text-gray-500">Subtotaal</th>
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
                      <td className="px-4 py-2 text-sm text-right">{qty}</td>
                      <td className="px-4 py-2 text-sm text-right">{unitPrice.toFixed(2)} {item.currency || order.currency || "EUR"}</td>
                      <td className="px-4 py-2 text-sm text-right">{(unitPrice * qty).toFixed(2)} {item.currency || order.currency || "EUR"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </PageContainer>
    </div>
  );
}
