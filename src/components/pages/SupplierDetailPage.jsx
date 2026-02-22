import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Pencil, Trash2 } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import Modal from "../shared/Modal";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { deleteSupplier, getSupplier } from "../../services/firebaseSuppliers";
import { getUserDisplayName } from "../../services/firebaseUserManagement";
import { usePermission } from "../../hooks/usePermission";

function formatDate(value) {
  if (!value) return "-";
  if (typeof value?.toDate === "function") return value.toDate().toLocaleString();
  if (typeof value?.seconds === "number") return new Date(value.seconds * 1000).toLocaleString();
  return String(value);
}

function DetailField({ label, value }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-sm text-gray-800 mt-1">{value === null || value === undefined || value === "" ? "-" : String(value)}</p>
    </div>
  );
}

export default function SupplierDetailPage() {
  const navigate = useNavigate();
  const { supplierId } = useParams();
  const { hotelUid } = useHotelContext();
  const canEditSuppliers = usePermission("suppliers", "update");
  const canDeleteSuppliers = usePermission("suppliers", "delete");
  const [supplier, setSupplier] = useState(null);
  const [loading, setLoading] = useState(true);
  const [createdByName, setCreatedByName] = useState("-");
  const [updatedByName, setUpdatedByName] = useState("-");
  const [showDeleteModal, setShowDeleteModal] = useState(false);

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
    const loadSupplier = async () => {
      if (!hotelUid || !supplierId) return;
      setLoading(true);
      const data = await getSupplier(hotelUid, supplierId);
      setSupplier(data);
      setLoading(false);
    };
    loadSupplier();
  }, [hotelUid, supplierId]);

  useEffect(() => {
    const loadUserNames = async () => {
      if (!supplier) return;
      const [createdName, updatedName] = await Promise.all([
        getUserDisplayName(supplier.createdBy),
        getUserDisplayName(supplier.updatedBy),
      ]);
      setCreatedByName(createdName);
      setUpdatedByName(updatedName);
    };
    loadUserNames();
  }, [supplier]);

  const handleDelete = async () => {
    if (!hotelUid || !supplierId || !canDeleteSuppliers) return;
    await deleteSupplier(hotelUid, supplierId);
    setShowDeleteModal(false);
    navigate("/catalog/suppliers");
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-100 to-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">Catalog</p>
            <h1 className="text-3xl font-semibold">Supplier Detail</h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate(`/catalog/suppliers/${supplierId}/edit`)}
              disabled={!canEditSuppliers}
              className={`inline-flex items-center justify-center rounded border p-2 ${
                canEditSuppliers
                  ? "border-gray-300 text-gray-700 hover:bg-gray-100"
                  : "border-gray-200 text-gray-400 cursor-not-allowed"
              }`}
              title="Edit supplier"
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setShowDeleteModal(true)}
              disabled={!canDeleteSuppliers}
              className={`inline-flex items-center justify-center rounded border p-2 ${
                canDeleteSuppliers
                  ? "border-red-200 text-red-700 hover:bg-red-50"
                  : "border-gray-200 text-gray-400 cursor-not-allowed"
              }`}
              title="Delete supplier"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>

        {loading ? (
          <p className="text-gray-600">Loading supplier...</p>
        ) : !supplier ? (
          <Card>
            <p className="text-gray-600">Supplier not found.</p>
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="lg:col-span-2">
              <h2 className="text-2xl font-semibold text-gray-900">{supplier.name || "-"}</h2>
              <p className="text-gray-600 mt-1">Account number: {supplier.accountNumber || "-"}</p>
            </Card>

            <Card>
              <h2 className="text-lg font-semibold mb-3">Contact</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <DetailField label="Order Email" value={supplier.orderEmail} />
                <DetailField label="Phone" value={supplier.phone} />
              </div>
              <div className="mt-4">
                <DetailField label="Notes" value={supplier.notes} />
              </div>
            </Card>

            <Card>
              <h2 className="text-lg font-semibold mb-3">Ordering</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <DetailField label="Order System" value={supplier.orderSystem} />
                <DetailField label="Category" value={supplier.category} />
                <DetailField label="Subcategory" value={supplier.subcategory} />
              </div>
            </Card>

            <Card>
              <h2 className="text-lg font-semibold mb-3">Webshop Access</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <DetailField label="Webshop URL" value={supplier.webshopUrl} />
                <DetailField label="Username" value={supplier.username} />
                <DetailField label="Password" value={supplier.password} />
              </div>
            </Card>

            <Card>
              <h2 className="text-lg font-semibold mb-3">Audit</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <DetailField label="Created At" value={formatDate(supplier.createdAt)} />
                <DetailField label="Created By" value={createdByName} />
                <DetailField label="Updated At" value={formatDate(supplier.updatedAt)} />
                <DetailField label="Updated By" value={updatedByName} />
              </div>
            </Card>
          </div>
        )}
      </PageContainer>

      <Modal open={showDeleteModal} onClose={() => setShowDeleteModal(false)} title="Delete supplier">
        <p className="text-sm text-gray-700">Are you sure you want to delete this supplier?</p>
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
            onClick={handleDelete}
            disabled={!canDeleteSuppliers}
            className={`px-4 py-2 rounded ${
              canDeleteSuppliers
                ? "bg-red-600 text-white hover:bg-red-700"
                : "bg-gray-300 text-gray-500 cursor-not-allowed"
            }`}
          >
            Delete
          </button>
        </div>
      </Modal>
    </div>
  );
}
