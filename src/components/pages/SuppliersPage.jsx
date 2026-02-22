import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getSuppliers } from "../../services/firebaseSuppliers";
import { usePermission } from "../../hooks/usePermission";

export default function SuppliersPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const canCreateSuppliers = usePermission("supplierproducts", "create");
  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");

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
    const loadSuppliers = async () => {
      if (!hotelUid) return;
      setLoading(true);
      const result = await getSuppliers(hotelUid);
      setSuppliers(result);
      setLoading(false);
    };
    loadSuppliers();
  }, [hotelUid]);

  const filteredSuppliers = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return suppliers.filter((supplier) => {
      const name = String(supplier.name || "").toLowerCase();
      const orderEmail = String(supplier.orderEmail || "").toLowerCase();
      const accountNumber = String(supplier.accountNumber || "").toLowerCase();
      return !term || name.includes(term) || orderEmail.includes(term) || accountNumber.includes(term);
    });
  }, [suppliers, searchTerm]);

  const columns = [
    { key: "name", label: "Name" },
    { key: "accountNumber", label: "Account Number" },
    { key: "orderEmail", label: "Order Email" },
    { key: "orderSystem", label: "Order System" },
    { key: "category", label: "Category" },
    { key: "subcategory", label: "Subcategory" },
  ];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">Catalog</p>
            <h1 className="text-3xl font-semibold">Suppliers</h1>
            <p className="text-gray-600 mt-1">Manage suppliers and ordering details.</p>
          </div>
          <button
            onClick={() => navigate("/catalog/suppliers/new")}
            disabled={!canCreateSuppliers}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold shadow ${
              canCreateSuppliers
                ? "bg-[#b41f1f] text-white hover:bg-[#961919]"
                : "bg-gray-300 text-gray-500 cursor-not-allowed"
            }`}
          >
            <Plus className="h-4 w-4" /> Add Supplier
          </button>
        </div>

        <div>
          <label className="sr-only" htmlFor="suppliers-search">
            Search suppliers
          </label>
          <input
            id="suppliers-search"
            type="text"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Search by name, account number or order email"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
          />
        </div>

        {loading ? (
          <p className="text-gray-600">Loading suppliers...</p>
        ) : (
          <DataListTable
            columns={columns}
            rows={filteredSuppliers}
            onRowClick={(supplier) => navigate(`/catalog/suppliers/${supplier.id}`)}
            emptyMessage="No suppliers found."
          />
        )}
      </PageContainer>
    </div>
  );
}
