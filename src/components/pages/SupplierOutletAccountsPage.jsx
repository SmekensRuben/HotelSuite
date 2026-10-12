import React, { useCallback, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getSupplierOutletAccounts } from "../../services/firebaseSuppliers";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import AsyncError from "../shared/AsyncError";
import { usePermission } from "../../hooks/usePermission";

export default function SupplierOutletAccountsPage() {
  const navigate = useNavigate();
  const { supplierId } = useParams();
  const { hotelUid } = useHotelContext();
  const load = useCallback(() => getSupplierOutletAccounts(hotelUid, { supplierId }), [hotelUid, supplierId]);
  const query = useScopedAsync({ scopeKey: `${hotelUid}:${supplierId}`, enabled: Boolean(hotelUid && supplierId), load });
  const accounts = query.data || [];
  const loading = query.loading;
  const canCreate = usePermission("suppliers", "update");

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

  const columns = [
    { key: "supplierName", label: "Supplier", render: (row) => row.supplierName || row.supplierId || "-" },
    { key: "outlet", label: "Outlet", render: (row) => row.outletName || row.outletId || "-" },
    { key: "accountNumber", label: "Account Number" },
  ];

  return (
    <div className="min-h-screen bg-canvas text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <ProcurementPage className="space-y-6">
        <AsyncError error={query.error} onRetry={query.retry} label="Could not load supplier outlet accounts." />
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">Catalog</p>
            <h1 className="text-3xl font-semibold">Supplier Outlet Accounts</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => navigate(`/catalog/suppliers/${supplierId}`)}
              className="inline-flex h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Back
            </button>
            <button
              type="button"
              disabled={!canCreate}
              onClick={() => navigate(`/catalog/suppliers/${supplierId}/outlet-accounts/new`)}
              className="inline-flex h-10 items-center justify-center rounded-lg bg-brand-800 px-4 text-sm font-medium text-white hover:bg-brand-950 disabled:opacity-50"
            >
              <Plus className="mr-2 h-4 w-4" /> New account
            </button>
          </div>
        </div>

        {loading ? (
          <p className="text-gray-600">Loading supplier outlet accounts...</p>
        ) : query.error ? null : (
          <DataListTable columns={columns} rows={accounts} emptyMessage="No supplier outlet accounts found." />
        )}
      </ProcurementPage>
    </div>
  );
}
