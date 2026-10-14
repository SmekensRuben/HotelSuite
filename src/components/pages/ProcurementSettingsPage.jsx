import React, { lazy, Suspense, useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Boxes, Layers3, Settings2, Store } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import { auth, signOut } from "../../firebaseConfig";
import { usePermission } from "../../hooks/usePermission";
import { useProcurementSettingsScope } from "../../hooks/useProcurementSettingsScope";

const Categories = lazy(() => import("./SettingsCatalogPage"));
const Outlets = lazy(() => import("./OutletSettingsPage"));
const Locations = lazy(() => import("./LocationSettingsPage"));
const SupplierImportMappings = lazy(() => import("./SupplierImportMappingSettingsSection"));

export default function ProcurementSettingsPage() {
  const [params, setParams] = useSearchParams();
  const { scopeKey } = useProcurementSettingsScope();
  const canReadCategories = usePermission("catalogsettings", "read");
  const canReadOutlets = usePermission("outlets", "read");
  const canReadLocations = usePermission("locations", "read");
  const canReadSuppliers = usePermission("suppliers", "read");
  const canReadSupplierProducts = usePermission("supplierproducts", "read");
  const canReadSupplierMappings = canReadSuppliers && canReadSupplierProducts;
  const sections = [
    { id: "categories", label: "Categories", description: "Catalog organization", icon: Layers3, Page: Categories, allowed: canReadCategories },
    { id: "outlets", label: "Outlets", description: "Purchasing & approvers", icon: Store, Page: Outlets, allowed: canReadOutlets },
    { id: "locations", label: "Locations & templates", description: "Storage & stock counts", icon: Boxes, Page: Locations, allowed: canReadLocations },
    { id: "supplier-imports", label: "Supplier import mappings", description: "Purchase-package codes", icon: Settings2, Page: SupplierImportMappings, allowed: canReadSupplierMappings },
  ].filter((section) => section.allowed);
  const requested = params.get("section");
  const active = sections.find((section) => section.id === requested) || sections[0];
  // Choose an allowed panel before mounting it; URL normalization never mounts a forbidden panel.
  useEffect(() => {
    if (active && requested !== active.id) {
      setParams({ section: active.id }, { replace: true });
    }
  }, [active?.id, requested, setParams]);
  const Page = active?.Page;
  return <div className="min-h-screen bg-canvas text-gray-900">
    <HeaderBar today={new Date().toLocaleDateString()} onLogout={async () => {
      await signOut(auth);
      sessionStorage.clear();
      window.location.href = "/login";
    }} />
    <ProcurementPage className="space-y-6">
      <div className="flex items-start gap-3 border-b border-gray-200 pb-6">
        <span className="hidden rounded-xl bg-brand-50 p-3 text-brand-800 sm:inline-flex"><Settings2 className="h-6 w-6" aria-hidden="true" /></span>
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">Purchasing &amp; Inventory</p>
          <h1 className="mt-1 text-3xl font-semibold">Module settings</h1>
          <p className="mt-2 max-w-2xl text-sm text-gray-600">Set up your catalog, purchasing outlets, physical stock locations and supplier import mappings in one place.</p>
        </div>
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="min-w-0">
          <nav aria-label="Purchasing & Inventory settings sections" className="flex flex-wrap gap-2 lg:flex-col">
            {sections.map(({ id, label, description, icon: Icon }) => <Link key={id} to={`/settings/procurement?section=${id}`}
              aria-label={label}
              aria-current={active?.id === id ? "page" : undefined}
              className={`inline-flex min-w-0 items-center gap-3 rounded-xl border px-3 py-2.5 text-sm transition-colors lg:w-full lg:py-3.5 ${active?.id === id ? "border-brand-100 bg-brand-50 text-brand-900" : "border-transparent text-gray-600 hover:border-gray-200 hover:bg-white"}`}>
              <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
              <span className="min-w-0"><span className="font-semibold">{label}</span><span className="mt-0.5 hidden text-xs font-normal text-gray-500 lg:block">{description}</span></span>
            </Link>)}
          </nav>
          <p className="mt-4 hidden border-t border-gray-200 pt-4 text-xs leading-relaxed text-gray-500 lg:block">Your hotel permissions determine which settings you can view and change.</p>
        </aside>
        <div className="min-w-0">
          {Page ? <Suspense fallback={<p role="status" className="py-4 text-sm text-gray-600">Loading settings section...</p>}>
            <Page key={`${scopeKey}:${active.id}`} />
          </Suspense> : <p role="alert" className="rounded-xl border border-gray-200 bg-white p-5 text-sm text-gray-600">You do not have access to this module's settings.</p>}
        </div>
      </div>
    </ProcurementPage>
  </div>;
}
