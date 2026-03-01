import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getShoppingCarts } from "../../services/firebaseShoppingCarts";

function formatDateTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

export default function OrdersPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [carts, setCarts] = useState([]);
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
    const loadCarts = async () => {
      if (!hotelUid) return;
      setLoading(true);
      const result = await getShoppingCarts(hotelUid);
      setCarts(result);
      setLoading(false);
    };

    loadCarts();
  }, [hotelUid]);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer>
        <Card>
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold">Orders</h1>
              <p className="text-sm text-gray-500 mt-1">Overzicht van shopping carts / orders.</p>
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
          ) : carts.length === 0 ? (
            <p className="mt-6 text-sm text-gray-600">Nog geen orders gevonden.</p>
          ) : (
            <div className="mt-6 overflow-x-auto">
              <table className="min-w-full border border-gray-200 rounded">
                <thead className="bg-gray-100 text-xs uppercase text-gray-600">
                  <tr>
                    <th className="text-left px-4 py-2">Order ID</th>
                    <th className="text-left px-4 py-2">Created By</th>
                    <th className="text-left px-4 py-2">Created At</th>
                    <th className="text-left px-4 py-2">Updated At</th>
                    <th className="text-right px-4 py-2">Items</th>
                    <th className="text-right px-4 py-2">Acties</th>
                  </tr>
                </thead>
                <tbody>
                  {carts.map((cart) => (
                    <tr key={cart.id} className="border-t border-gray-200 text-sm">
                      <td className="px-4 py-2 font-mono">{cart.id}</td>
                      <td className="px-4 py-2">{cart.createdBy || "-"}</td>
                      <td className="px-4 py-2">{formatDateTime(cart.createdAtDate)}</td>
                      <td className="px-4 py-2">{formatDateTime(cart.updatedAtDate)}</td>
                      <td className="px-4 py-2 text-right">{Array.isArray(cart.items) ? cart.items.length : 0}</td>
                      <td className="px-4 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => navigate(`/orders/cart/${cart.id}`)}
                          className="text-blue-600 hover:text-blue-800 font-semibold"
                        >
                          Open
                        </button>
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
