import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getOrders } from "../../services/firebaseOrders";

function formatDateTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

export default function OrdersPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

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
    const loadOrders = async () => {
      if (!hotelUid) return;
      setLoading(true);
      const result = await getOrders(hotelUid);
      setOrders(result);
      setLoading(false);
    };

    loadOrders();
  }, [hotelUid]);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer>
        <Card>
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold">Orders</h1>
              <p className="text-sm text-gray-500 mt-1">Overzicht van orders.</p>
            </div>
            <button
              type="button"
              onClick={() => navigate("/orders/new")}
              className="inline-flex items-center gap-2 bg-blue-600 text-white rounded px-4 py-2 font-semibold hover:bg-blue-700"
            >
              <Plus className="w-4 h-4" />
              Nieuwe order
            </button>
          </div>

          {loading ? (
            <p className="mt-6 text-sm text-gray-600">Orders laden...</p>
          ) : orders.length === 0 ? (
            <p className="mt-6 text-sm text-gray-600">Nog geen orders gevonden.</p>
          ) : (
            <div className="mt-6 overflow-x-auto">
              <table className="min-w-full border border-gray-200 rounded">
                <thead className="bg-gray-100 text-xs uppercase text-gray-600">
                  <tr>
                    <th className="text-left px-4 py-2">Order ID</th>
                    <th className="text-left px-4 py-2">Status</th>
                    <th className="text-left px-4 py-2">Delivery Date</th>
                    <th className="text-left px-4 py-2">Created By</th>
                    <th className="text-left px-4 py-2">Created At</th>
                    <th className="text-right px-4 py-2">Items</th>
                    <th className="text-right px-4 py-2">Totaal</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order) => (
                    <tr key={order.id} className="border-t border-gray-200 text-sm">
                      <td className="px-4 py-2 font-mono">{order.id}</td>
                      <td className="px-4 py-2">{order.status}</td>
                      <td className="px-4 py-2">{order.deliveryDate || "-"}</td>
                      <td className="px-4 py-2">{order.createdBy || "-"}</td>
                      <td className="px-4 py-2">{formatDateTime(order.createdAtDate)}</td>
                      <td className="px-4 py-2 text-right">{Array.isArray(order.products) ? order.products.length : 0}</td>
                      <td className="px-4 py-2 text-right">
                        {Number(order.totalAmount || 0).toFixed(2)} {order.currency || "EUR"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </PageContainer>
    </div>
  );
}
