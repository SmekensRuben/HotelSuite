import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getOutlets } from "../../services/firebaseSettings";
import { createSupplierOutletAccount, getSuppliers } from "../../services/firebaseSuppliers";

export default function SupplierOutletAccountCreatePage() {
  const navigate = useNavigate();
  const { supplierId } = useParams();
  const { hotelUid } = useHotelContext();
  const [suppliers, setSuppliers] = useState([]);
  const [outlets, setOutlets] = useState([]);
  const [formState, setFormState] = useState({ supplier: "", outlet: "", accountNumber: "" });
  const [saving, setSaving] = useState(false);

  const today = useMemo(
    () =>
      new Date().toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
    []
  );

  const supplierLookup = useMemo(() => {
    const byId = {};
    const byName = {};

    suppliers.forEach((supplier) => {
      const id = String(supplier?.id || "").trim();
      const name = String(supplier?.name || "").trim();
      if (id) byId[id.toLowerCase()] = supplier;
      if (!name) return;

      const key = name.toLowerCase();
      if (!byName[key]) byName[key] = supplier;
      else byName[key] = null;
    });

    return { byId, byName };
  }, [suppliers]);

  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  useEffect(() => {
    const loadOptions = async () => {
      if (!hotelUid) return;
      const [loadedSuppliers, loadedOutlets] = await Promise.all([
        getSuppliers(hotelUid),
        getOutlets(hotelUid),
      ]);
      setSuppliers(loadedSuppliers || []);
      setOutlets(loadedOutlets || []);

      const selectedSupplier = (loadedSuppliers || []).find((item) => item.id === supplierId);
      if (selectedSupplier?.name) {
        setFormState((prev) => ({ ...prev, supplier: selectedSupplier.name }));
      }
    };

    loadOptions();
  }, [hotelUid, supplierId]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!hotelUid) return;

    const supplierValue = String(formState.supplier || "").trim();
    const supplier =
      supplierLookup.byName[supplierValue.toLowerCase()] ||
      supplierLookup.byId[supplierValue.toLowerCase()] ||
      null;

    if (!supplier) {
      window.alert("Selecteer een bestaande supplier.");
      return;
    }

    setSaving(true);
    try {
      const actor = auth.currentUser?.uid || "unknown";
      await createSupplierOutletAccount(
        hotelUid,
        {
          supplierId: supplier.id,
          supplierName: String(supplier.name || "").trim() || supplier.id,
          outlet: String(formState.outlet || "").trim(),
          accountNumber: String(formState.accountNumber || "").trim(),
        },
        actor
      );
      navigate(`/catalog/suppliers/${supplier.id}/outlet-accounts`);
    } catch (error) {
      console.error("Failed to create supplier outlet account", error);
      window.alert(String(error?.message || "Kon supplier outlet account niet aanmaken."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">Catalog</p>
            <h1 className="text-3xl font-semibold">Nieuwe Supplier Outlet Account</h1>
          </div>
          <button
            type="button"
            onClick={() => navigate(`/catalog/suppliers/${supplierId}/outlet-accounts`)}
            className="inline-flex h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Terug
          </button>
        </div>

        <Card>
          <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
              Supplier *
              <input
                required
                list="supplier-options"
                value={formState.supplier}
                onChange={(event) => setFormState((prev) => ({ ...prev, supplier: event.target.value }))}
                className="rounded border border-gray-300 px-3 py-2 text-sm"
                placeholder="Kies supplier naam"
              />
              <datalist id="supplier-options">
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.name || supplier.id} />
                ))}
              </datalist>
            </label>

            <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
              Outlet *
              <select
                required
                value={formState.outlet}
                onChange={(event) => setFormState((prev) => ({ ...prev, outlet: event.target.value }))}
                className="rounded border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="">Kies outlet</option>
                {outlets.map((outlet) => (
                  <option key={outlet.id || outlet.name} value={outlet.name || outlet.id}>
                    {outlet.name || outlet.id}
                  </option>
                ))}
              </select>
            </label>

            <label className="sm:col-span-2 flex flex-col gap-1 text-sm font-semibold text-gray-700">
              Account Number *
              <input
                required
                value={formState.accountNumber}
                onChange={(event) => setFormState((prev) => ({ ...prev, accountNumber: event.target.value }))}
                className="rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </label>

            <div className="sm:col-span-2 flex justify-end">
              <button
                type="submit"
                disabled={saving}
                className="inline-flex h-10 items-center justify-center rounded-lg bg-[#b41f1f] px-4 text-sm font-semibold text-white hover:bg-[#961919] disabled:opacity-50"
              >
                {saving ? "Opslaan..." : "Opslaan"}
              </button>
            </div>
          </form>
        </Card>
      </PageContainer>
    </div>
  );
}
