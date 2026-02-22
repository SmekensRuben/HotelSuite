import React, { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import SupplierFormFields from "./SupplierFormFields";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { createSupplier } from "../../services/firebaseSuppliers";

export default function SupplierCreatePage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();

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

  const handleCreate = async (payload) => {
    const actor = auth.currentUser?.uid || "unknown";
    const supplierId = await createSupplier(hotelUid, payload, actor);
    navigate(`/catalog/suppliers/${supplierId}`);
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div>
          <p className="text-sm text-gray-500 uppercase tracking-wide">Catalog</p>
          <h1 className="text-3xl font-semibold">Add Supplier</h1>
        </div>

        <Card>
          <SupplierFormFields
            onSubmit={handleCreate}
            savingLabel="Creating supplier..."
            submitLabel="Create Supplier"
          />
        </Card>
      </PageContainer>
    </div>
  );
}
