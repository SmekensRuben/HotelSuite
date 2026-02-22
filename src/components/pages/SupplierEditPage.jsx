import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import SupplierFormFields from "./SupplierFormFields";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getSupplier, updateSupplier } from "../../services/firebaseSuppliers";
import { usePermission } from "../../hooks/usePermission";

export default function SupplierEditPage() {
  const navigate = useNavigate();
  const { supplierId } = useParams();
  const { hotelUid } = useHotelContext();
  const canViewSupplierPassword = usePermission("suppliers", "password");
  const [supplier, setSupplier] = useState(null);
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
    const loadSupplier = async () => {
      if (!hotelUid || !supplierId) return;
      setLoading(true);
      const data = await getSupplier(hotelUid, supplierId);
      const sanitizedSupplier =
        !data || canViewSupplierPassword ? data : { ...data, password: "" };
      setSupplier(sanitizedSupplier);
      setLoading(false);
    };
    loadSupplier();
  }, [hotelUid, supplierId, canViewSupplierPassword]);

  const handleUpdate = async (payload) => {
    const actor = auth.currentUser?.uid || "unknown";
    await updateSupplier(hotelUid, supplierId, payload, actor);
    navigate(`/catalog/suppliers/${supplierId}`);
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div>
          <p className="text-sm text-gray-500 uppercase tracking-wide">Catalog</p>
          <h1 className="text-3xl font-semibold">Edit Supplier</h1>
        </div>

        {loading ? (
          <p className="text-gray-600">Loading supplier...</p>
        ) : !supplier ? (
          <Card>
            <p className="text-gray-600">Supplier not found.</p>
          </Card>
        ) : (
          <Card>
            <SupplierFormFields
              initialValues={supplier}
              onSubmit={handleUpdate}
              savingLabel="Saving supplier..."
              submitLabel="Save Supplier"
            />
          </Card>
        )}
      </PageContainer>
    </div>
  );
}
