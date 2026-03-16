import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getSupplierOutletAccounts } from "../../services/firebaseSuppliers";

export default function SupplierOutletAccountsPage() {
  const navigate = useNavigate();
  const { supplierId } = useParams();
  const { hotelUid } = useHotelContext();
  const [accounts, setAccounts] = useState([]);
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
    const loadAccounts = async () => {
      if (!hotelUid) return;
      setLoading(true);
      const data = await getSupplierOutletAccounts(hotelUid, { supplierId });
      setAccounts(data);
      setLoading(false);
    };

    loadAccounts();
  }, [hotelUid, supplierId]);

  const columns = [
    { key: "supplierName", label: "Supplier", render: (row) => row.supplierName || row.supplierId || "-" },
    { key: "outlet", label: "Outlet", render: (row) => row.outletName || row.outletId || "-" },
    { key: "accountNumber", label: "Account Number" },
  ];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">Catalog</p>
            <h1 className="text-3xl font-semibold">Supplier Outlet Accounts</h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate(`/catalog/suppliers/${supplierId}`)}
              className="inline-flex h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Terug
            </button>
            <button
              type="button"
              onClick={() => navigate(`/catalog/suppliers/${supplierId}/outlet-accounts/new`)}
              className="inline-flex h-10 items-center justify-center rounded-lg bg-[#b41f1f] px-4 text-sm font-medium text-white hover:bg-[#961919]"
            >
              <Plus className="mr-2 h-4 w-4" /> Nieuw
            </button>
          </div>
        </div>

        {loading ? (
          <p className="text-gray-600">Loading supplier outlet accounts...</p>
        ) : (
          <DataListTable columns={columns} rows={accounts} emptyMessage="Geen supplier outlet accounts gevonden." />
        )}
      </PageContainer>
    </div>
  );
}
