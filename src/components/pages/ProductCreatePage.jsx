import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { createCatalogProduct } from "../../services/firebaseProducts";

const initialState = {
  name: "",
  brand: "",
  description: "",
  active: true,
  category: "",
  subcategory: "",
  baseUnit: "",
  baseQtyPerUnit: "",
  gtin: "",
  internalSku: "",
  storageType: "",
  allergens: "",
  notes: "",
};

export default function ProductCreatePage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [formState, setFormState] = useState(initialState);
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

  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  const updateField = (key, value) => {
    setFormState((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!hotelUid || !formState.name.trim()) return;
    setSaving(true);

    const payload = {
      name: formState.name.trim(),
      brand: formState.brand.trim(),
      description: formState.description.trim(),
      active: formState.active,
      category: formState.category.trim(),
      subcategory: formState.subcategory.trim(),
      baseUnit: formState.baseUnit.trim(),
      baseQtyPerUnit: Number(formState.baseQtyPerUnit) || 0,
      gtin: formState.gtin.trim(),
      internalSku: formState.internalSku.trim(),
      storageType: formState.storageType.trim(),
      allergens: formState.allergens
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      notes: formState.notes.trim(),
    };

    const actor = auth.currentUser?.email || auth.currentUser?.uid || "unknown";
    const productId = await createCatalogProduct(hotelUid, payload, actor);
    navigate(`/catalog/products/${productId}`);
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div>
          <p className="text-sm text-gray-500 uppercase tracking-wide">Catalog</p>
          <h1 className="text-3xl font-semibold">Nieuw Product</h1>
        </div>

        <Card>
          <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
              Naam *
              <input
                required
                value={formState.name}
                onChange={(event) => updateField("name", event.target.value)}
                className="rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
              Merk
              <input
                value={formState.brand}
                onChange={(event) => updateField("brand", event.target.value)}
                className="rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700 sm:col-span-2">
              Beschrijving
              <textarea
                value={formState.description}
                onChange={(event) => updateField("description", event.target.value)}
                className="rounded border border-gray-300 px-3 py-2 text-sm min-h-24"
              />
            </label>
            <label className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              <input
                type="checkbox"
                checked={formState.active}
                onChange={(event) => updateField("active", event.target.checked)}
              />
              Actief
            </label>

            <h2 className="sm:col-span-2 text-lg font-semibold text-gray-900 mt-2">Classification</h2>
            <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
              Categorie
              <input
                value={formState.category}
                onChange={(event) => updateField("category", event.target.value)}
                className="rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
              Subcategorie
              <input
                value={formState.subcategory}
                onChange={(event) => updateField("subcategory", event.target.value)}
                className="rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </label>

            <h2 className="sm:col-span-2 text-lg font-semibold text-gray-900 mt-2">Units & Normalisation</h2>
            <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
              Base Unit
              <input
                value={formState.baseUnit}
                onChange={(event) => updateField("baseUnit", event.target.value)}
                className="rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
              Base Qty Per Unit
              <input
                type="number"
                step="0.01"
                min="0"
                value={formState.baseQtyPerUnit}
                onChange={(event) => updateField("baseQtyPerUnit", event.target.value)}
                className="rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </label>

            <h2 className="sm:col-span-2 text-lg font-semibold text-gray-900 mt-2">Identifiers</h2>
            <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
              GTIN
              <input
                value={formState.gtin}
                onChange={(event) => updateField("gtin", event.target.value)}
                className="rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
              Internal SKU
              <input
                value={formState.internalSku}
                onChange={(event) => updateField("internalSku", event.target.value)}
                className="rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </label>

            <h2 className="sm:col-span-2 text-lg font-semibold text-gray-900 mt-2">Storage & Operationally</h2>
            <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
              Storage Type
              <input
                value={formState.storageType}
                onChange={(event) => updateField("storageType", event.target.value)}
                className="rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
              Allergens (komma gescheiden)
              <input
                value={formState.allergens}
                onChange={(event) => updateField("allergens", event.target.value)}
                className="rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700 sm:col-span-2">
              Notes
              <textarea
                value={formState.notes}
                onChange={(event) => updateField("notes", event.target.value)}
                className="rounded border border-gray-300 px-3 py-2 text-sm min-h-24"
              />
            </label>

            <div className="sm:col-span-2 flex items-center gap-3 pt-2">
              <button
                type="submit"
                disabled={saving}
                className="bg-[#b41f1f] text-white px-4 py-2 rounded font-semibold shadow hover:bg-[#961919] transition-colors disabled:opacity-60"
              >
                {saving ? "Opslaan..." : "Product aanmaken"}
              </button>
              <button
                type="button"
                onClick={() => navigate("/catalog/products")}
                className="px-4 py-2 rounded border border-gray-300 font-semibold text-gray-700"
              >
                Annuleren
              </button>
            </div>
          </form>
        </Card>
      </PageContainer>
    </div>
  );
}
