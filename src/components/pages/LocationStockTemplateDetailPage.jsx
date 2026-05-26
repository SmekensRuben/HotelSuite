import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Pencil, Plus, Trash2 } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import Modal from "../shared/Modal";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getSupplierProducts } from "../../services/firebaseProducts";
import { getOutlets } from "../../services/firebaseSettings";
import {
  addLocationStockTemplateItem,
  getLocationStockTemplateById,
  removeLocationStockTemplateItem,
} from "../../services/firebaseSettings";

export default function LocationStockTemplateDetailPage() {
  const { locationId, templateId } = useParams();
  const { hotelUid } = useHotelContext();
  const navigate = useNavigate();
  const [template, setTemplate] = useState(null);
  const [supplierProducts, setSupplierProducts] = useState([]);
  const [outlets, setOutlets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedOutletId, setSelectedOutletId] = useState("");
  const [activeOutletFilter, setActiveOutletFilter] = useState("");
  const [isEditMode, setIsEditMode] = useState(false);
  const [confirmDeleteItem, setConfirmDeleteItem] = useState(null);

  const today = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);
  const handleLogout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };

  const load = async () => {
    if (!hotelUid || !locationId || !templateId) return;
    setLoading(true);
    const [templateData, products, outletList] = await Promise.all([
      getLocationStockTemplateById(hotelUid, locationId, templateId),
      getSupplierProducts(hotelUid),
      getOutlets(hotelUid),
    ]);
    setTemplate(templateData);
    setSupplierProducts(Array.isArray(products) ? products : products.products || []);
    setOutlets(outletList);
    setLoading(false);
  };

  useEffect(() => { load(); }, [hotelUid, locationId, templateId]);

  const filteredProducts = supplierProducts.filter((product) => {
    const text = `${product.supplierProductName || ""} ${product.supplierName || ""}`.toLowerCase();
    return text.includes(search.toLowerCase());
  });

  const rows = (template?.items || [])
    .filter((item) => !activeOutletFilter || item.outletId === activeOutletFilter)
    .map((item) => ({
      ...item,
      pricePerPurchaseUnit: Number(item.pricePerPurchaseUnit || 0).toFixed(2),
      actions: isEditMode ? (
        <button
          type="button"
          className="inline-flex items-center justify-center rounded p-1 text-red-600 hover:bg-red-50"
          title="Remove stock template item"
          onClick={(event) => {
            event.stopPropagation();
            setConfirmDeleteItem(item);
          }}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      ) : null,
    }));

  const handleSaveItem = async () => {
    if (!selectedProduct || !selectedOutletId) return;
    const outlet = outlets.find((item) => item.id === selectedOutletId);
    const baseUnitsPerPurchaseUnit = selectedProduct.baseUnitsPerPurchaseUnit || "-";
    const baseUnit = selectedProduct.baseUnit || "-";
    const purchaseUnit = selectedProduct.purchaseUnit || "-";
    await addLocationStockTemplateItem(hotelUid, locationId, templateId, {
      supplierProductId: selectedProduct.id,
      supplierProductName: selectedProduct.supplierProductName || selectedProduct.name || "-",
      supplierName: selectedProduct.supplierName || "-",
      content: `${baseUnitsPerPurchaseUnit} ${baseUnit} / ${purchaseUnit}`,
      outletId: selectedOutletId,
      outletName: outlet?.name || "-",
      pricePerPurchaseUnit: Number(selectedProduct.pricePerPurchaseUnit || 0),
    });
    setShowModal(false);
    setSearch("");
    setSelectedProduct(null);
    setSelectedOutletId("");
    await load();
  };

  const handleDeleteItem = async () => {
    if (!confirmDeleteItem) return;
    await removeLocationStockTemplateItem(hotelUid, locationId, templateId, confirmDeleteItem.id);
    setConfirmDeleteItem(null);
    await load();
  };

  return <div className="min-h-screen bg-gray-50 text-gray-900"><HeaderBar today={today} onLogout={handleLogout} /><PageContainer className="space-y-6"><div className="flex items-center justify-between gap-3"><h1 className="text-3xl font-semibold">Stock Template Detail</h1><button type="button" onClick={() => navigate(`/settings/locations/${locationId}`)} className="inline-flex items-center justify-center rounded border border-gray-300 p-2 text-gray-700 hover:bg-gray-100" title="Back"><ArrowLeft className="h-4 w-4" /></button></div>{loading ? <p className="text-gray-600">Loading stock template...</p> : !template ? <Card><p className="text-gray-600">Stock template not found.</p></Card> : <><Card className="flex items-center justify-between gap-4"><div><h2 className="text-2xl font-semibold">{template.name || "-"}</h2></div><div className="flex items-center gap-2"><button type="button" onClick={() => setIsEditMode((current) => !current)} className={`inline-flex items-center gap-2 rounded border px-3 py-2 text-sm ${isEditMode ? "border-blue-600 text-blue-700 bg-blue-50" : "border-gray-300 text-gray-700 hover:bg-gray-100"}`}><Pencil className="h-4 w-4" /></button><button type="button" onClick={() => setShowModal(true)} className="inline-flex items-center gap-2 rounded border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"><Plus className="h-4 w-4" /> New Location Stock Item</button></div></Card><Card><div className="mb-3 flex items-center justify-between gap-3"><h3 className="text-lg font-semibold">Stock Template Items</h3><select value={activeOutletFilter} onChange={(event) => setActiveOutletFilter(event.target.value)} className="rounded border border-gray-300 px-3 py-2 text-sm"><option value="">All Outlets</option>{outlets.map((outlet) => <option key={outlet.id} value={outlet.id}>{outlet.name}</option>)}</select></div><DataListTable columns={[{ key: "supplierProductName", label: "Supplier Product" }, { key: "supplierName", label: "Supplier" }, { key: "content", label: "Content" }, { key: "pricePerPurchaseUnit", label: "Price per Purchase Unit" }, { key: "outletName", label: "Outlet" }, ...(isEditMode ? [{ key: "actions", label: "" }] : [])]} rows={rows} emptyMessage="No stock template items yet." /></Card></>}</PageContainer><Modal open={showModal} onClose={() => setShowModal(false)} title="New Location Stock Item"><div className="space-y-3"><input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search supplier product" className="w-full rounded border border-gray-300 px-3 py-2 text-sm" /><div className="max-h-56 overflow-y-auto rounded border border-gray-200"><table className="w-full text-sm"><thead><tr className="bg-gray-50 text-left"><th className="px-2 py-2">Supplier Product</th><th className="px-2 py-2">Supplier</th><th className="px-2 py-2">Content</th></tr></thead><tbody>{filteredProducts.slice(0, 20).map((product) => { const content = `${product.baseUnitsPerPurchaseUnit || "-"} ${product.baseUnit || "-"} / ${product.purchaseUnit || "-"}`; const isSelected = selectedProduct?.id === product.id; return <tr key={product.id} className={`cursor-pointer ${isSelected ? "bg-blue-50" : "hover:bg-gray-50"}`} onClick={() => setSelectedProduct(product)}><td className="px-2 py-2">{product.supplierProductName || product.name || "-"}</td><td className="px-2 py-2">{product.supplierName || "-"}</td><td className="px-2 py-2">{content}</td></tr>; })}</tbody></table></div><select value={selectedOutletId} onChange={(e) => setSelectedOutletId(e.target.value)} className="w-full rounded border border-gray-300 px-3 py-2 text-sm"><option value="">Select outlet</option>{outlets.map((outlet) => <option key={outlet.id} value={outlet.id}>{outlet.name}</option>)}</select><div className="flex justify-end gap-2"><button type="button" className="rounded border border-gray-300 px-3 py-2 text-sm" onClick={() => setShowModal(false)}>Cancel</button><button type="button" className="rounded bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-60" disabled={!selectedProduct || !selectedOutletId} onClick={handleSaveItem}>Save</button></div></div></Modal><Modal open={Boolean(confirmDeleteItem)} onClose={() => setConfirmDeleteItem(null)} title="Remove Stock Template Item"><div className="space-y-3"><p className="text-sm text-gray-700">Are you sure you want to remove <span className="font-medium">{confirmDeleteItem?.supplierProductName || "this item"}</span> from this stock template?</p><div className="flex justify-end gap-2"><button type="button" className="rounded border border-gray-300 px-3 py-2 text-sm" onClick={() => setConfirmDeleteItem(null)}>Cancel</button><button type="button" className="rounded bg-red-600 px-3 py-2 text-sm text-white" onClick={handleDeleteItem}>Remove</button></div></div></Modal></div>;
}
