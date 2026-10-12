import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import { Card } from "../layout/Card";
import SupplierFormFields from "./SupplierFormFields";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getSupplier, getSupplierConnection, updateSupplier } from "../../services/firebaseSuppliers";
import { usePermission } from "../../hooks/usePermission";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import AsyncError from "../shared/AsyncError";

export default function SupplierEditPage() {
  const { supplierId } = useParams();
  const { hotelUid } = useHotelContext();
  return <ScopedSupplierEditPage key={`${hotelUid}:${supplierId}`} supplierId={supplierId} hotelUid={hotelUid} />;
}

function ScopedSupplierEditPage({ supplierId, hotelUid }) {
  const navigate = useNavigate();
  const canViewSupplierPassword = usePermission("suppliers", "password");
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const load = useCallback(async () => {
    const [data, connection] = await Promise.all([getSupplier(hotelUid, supplierId), canViewSupplierPassword ? getSupplierConnection(hotelUid, supplierId) : Promise.resolve({})]);
    return data ? { ...data, ...connection } : null;
  }, [hotelUid, supplierId, canViewSupplierPassword]);
  const query = useScopedAsync({ scopeKey: `${hotelUid}:${supplierId}:${canViewSupplierPassword}`, enabled: Boolean(hotelUid && supplierId), load });
  const supplier = query.data;
  const loading = query.loading;

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

  const handleUpdate = async (payload) => {
    const actor = auth.currentUser?.uid || "unknown";
    await updateSupplier(hotelUid, supplierId, payload, actor);
    if (mounted.current) navigate(`/catalog/suppliers/${supplierId}`);
  };

  return (
    <div className="min-h-screen bg-canvas text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <ProcurementPage width="form" className="space-y-6">
        <div>
          <p className="text-sm text-gray-500 uppercase tracking-wide">Catalog</p>
          <h1 className="text-3xl font-semibold">Edit Supplier</h1>
        </div>

        <AsyncError error={query.error} onRetry={query.retry} label="Could not load supplier settings." />
        {loading ? (
          <p className="text-gray-600">Loading supplier...</p>
        ) : query.error ? null : !supplier ? (
          <Card>
            <p className="text-gray-600">Supplier not found.</p>
          </Card>
        ) : (
          <Card>
            <SupplierFormFields
              initialValues={supplier}
              canManageCredentials={canViewSupplierPassword}
              onSubmit={handleUpdate}
              savingLabel="Saving supplier..."
              submitLabel="Save Supplier"
            />
          </Card>
        )}
      </ProcurementPage>
    </div>
  );
}
