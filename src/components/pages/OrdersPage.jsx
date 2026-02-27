import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getShoppingCarts } from "../../services/firebaseOrders";
import { usePermission } from "../../hooks/usePermission";

function formatDate(value) {
  if (!value) return "-";
  if (typeof value?.toDate === "function") return value.toDate().toLocaleString();
  if (typeof value?.seconds === "number") return new Date(value.seconds * 1000).toLocaleString();
  return String(value);
}

export default function OrdersPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const canCreateOrders = usePermission("orders", "create");
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
      const data = await getShoppingCarts(hotelUid);
      setOrders(data);
      setLoading(false);
    };

    loadOrders();
  }, [hotelUid]);

  const columns = [
    { key: "id", label: "Shopping Cart ID" },
    { key: "createdBy", label: "Created By" },
    {
      key: "createdAt",
      label: "Created At",
      render: (order) => formatDate(order.createdAt),
      sortValue: (order) => order.createdAt?.seconds || 0,
    },
    {
      key: "updatedAt",
      label: "Updated At",
      render: (order) => formatDate(order.updatedAt),
      sortValue: (order) => order.updatedAt?.seconds || 0,
    },
    {
      key: "itemsCount",
      label: "Items",
      render: (order) => order.items?.length || 0,
      sortValue: (order) => order.items?.length || 0,
    },
  ];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer>
        <Card>
          <div className="flex items-center justify-between gap-3 mb-4">
            <h1 className="text-2xl font-semibold">Orders</h1>
            {canCreateOrders && (
              <button
                onClick={() => navigate("/orders/new")}
                className="inline-flex items-center justify-center rounded-md bg-blue-600 p-2 text-white hover:bg-blue-700"
                title="Nieuwe order"
                aria-label="Nieuwe order"
              >
                <Plus className="h-5 w-5" />
              </button>
            )}
          </div>

          <DataListTable
            columns={columns}
            rows={orders}
            emptyMessage={loading ? "Orders laden..." : "Geen orders gevonden."}
          />
        </Card>
      </PageContainer>
    </div>
  );
}
