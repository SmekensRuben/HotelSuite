import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import PendingStockCommand from "../inventory/PendingStockCommand";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import { Card } from "../layout/Card";
import { Combobox } from "../ui/combobox";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { usePermission } from "../../hooks/usePermission";
import { useVerifiedRefresh } from "../../hooks/useVerifiedRefresh";
import { usePagedCatalogChoices } from "../../hooks/usePagedCatalogChoices";
import { ArticleRowsSkeleton, LoadingStatus } from "../ui/ResourceLoading";
import { PRODUCT_BASE_UNITS } from "../../utils/productPurchaseOptions";
import { productUnitLabel } from "../../utils/productUnitDisplay";
import {
  addLocationStockTemplateItem,
  getHotelStockTemplateDisplay,
  getPendingStockTemplateCommand,
  removeLocationStockTemplateItem,
  updateLocationStockTemplateItems,
} from "../../services/firebaseSettings";

const itemKey = (item) =>
  item.catalogProductId
    ? JSON.stringify(["catalog", item.catalogProductId])
    : JSON.stringify(["supplier", item.supplierProductId, item.outletId]);
export default function LocationStockTemplateDetailPage() {
  const { locationId, templateId } = useParams(),
    context = useHotelContext(),
    { hotelUid } = context,
    navigate = useNavigate();
  const canRead = usePermission("locations", "read"),
    canUpdate = usePermission("locations", "update"),
    canReadCatalog = usePermission("catalogproducts", "read");
  const actor = auth.currentUser, actorUid = actor?.uid || "";
  const actorIdentity = useRef({ actor: null, revision: 0 });
  if (actorIdentity.current.actor !== actor) actorIdentity.current = { actor, revision: actorIdentity.current.revision + 1 };
  const scopeKey = JSON.stringify([actorIdentity.current.revision, actorUid, hotelUid, locationId, templateId,
    canRead, canUpdate, canReadCatalog, context.permissions, context.authorizationSource,
    context.permissionsLoading, context.subscriptionLoading, context.subscriptionActive, context.subscription]);
  const active = useRef({ key: scopeKey });
  if (active.current.key !== scopeKey) active.current = { key: scopeKey };
  const [selected, setSelected] = useState(null),
    [saving, setSaving] = useState(false),
    [savingLabel, setSavingLabel] = useState(""),
    [error, setError] = useState("");
  const load = useCallback(
    () => getHotelStockTemplateDisplay(hotelUid, locationId, templateId, { scopeKey }),
    [hotelUid, locationId, templateId, scopeKey],
  );
  const query = useVerifiedRefresh({
    scopeKey,
    enabled: Boolean(actorUid && hotelUid && locationId && templateId && canRead
      && context.permissionsLoading !== true && context.subscriptionLoading !== true),
    load,
  });
  const products = usePagedCatalogChoices({ hotelUid, scopeKey, enabled: Boolean(actorUid && hotelUid && canReadCatalog && canRead
    && context.permissionsLoading !== true && context.subscriptionLoading !== true) });
  useEffect(() => {
    active.current = { key: scopeKey };
    setSelected(null);
    setSaving(false);
    setSavingLabel("");
    setError("");
    return () => {
      active.current = { key: null };
    };
  }, [scopeKey]);
  const template = query.data?.template,
    location = query.data?.location,
    items = template?.items || [];
  const displayByKey = useMemo(
    () =>
      Object.fromEntries(
        (query.data?.items || []).map((item) => [itemKey(item), item]),
      ),
    [query.data],
  );
  const eligible = useMemo(
    () =>
      (products.products || []).filter(
        (product) =>
          product.inventoryTracked === true &&
          PRODUCT_BASE_UNITS.includes(product.baseUnit) &&
          product.active !== false &&
          product.archived !== true &&
          !product.archivedAt &&
          !items.some((item) => item.catalogProductId === product.id),
      ),
    [products.products, items],
  );
  let hasSavedCommand = false;
  try {
    hasSavedCommand = Boolean(
      getPendingStockTemplateCommand(hotelUid, locationId, templateId),
    );
  } catch {
    // Recovery shows the storage error; no replacement may overwrite this intent.
    hasSavedCommand = true;
  }
  const cannotEdit =
    !actorUid ||
    !canUpdate ||
    !template ||
    !location ||
    template?.archived === true ||
    location?.archived === true;
  const disabled = cannotEdit || saving || hasSavedCommand || query.loading;
  const mutate = async (operation, label = "Updating template…") => {
    if (
      disabled ||
      !template ||
      active.current.busy ||
      auth.currentUser !== actor
    ) return;
    try {
      if (getPendingStockTemplateCommand(hotelUid, locationId, templateId)) {
        setError("Retry the original saved request before making another change.");
        return;
      }
    } catch (failure) {
      setError(failure.message || "The saved template command needs review.");
      return;
    }
    const requested = active.current;
    requested.busy = true;
    const isCurrent = () =>
      active.current === requested && auth.currentUser === actor;
    setSaving(true);
    setSavingLabel(label);
    setError("");
    try {
      await operation();
      if (isCurrent()) {
        setSelected(null);
        await query.retry();
      }
    } catch (failure) {
      if (isCurrent())
        setError(failure.message || "Unable to update the template.");
    } finally {
      requested.busy = false;
      if (isCurrent()) setSaving(false);
    }
  };
  const move = (index, direction) => {
    const next = [...items],
      target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    return mutate(
      () =>
        updateLocationStockTemplateItems(
          hotelUid,
          locationId,
          templateId,
          next,
          template.revision ?? 0,
        ),
      "Updating article order…",
    );
  };
  return (
    <div className="min-h-screen bg-canvas text-gray-900">
      <HeaderBar
        today={new Date().toLocaleDateString()}
        onLogout={async () => {
          await signOut(auth);
          sessionStorage.clear();
          window.location.href = "/login";
        }}
      />
      <ProcurementPage className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">
              Purchasing &amp; Inventory · Settings
            </p>
            <h1 className="mt-1 text-3xl font-semibold">
              Stock Template Detail
            </h1>
          </div>
          <button
            type="button"
            onClick={() => navigate(`/settings/locations/${locationId}`)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            Back to location
          </button>
        </div>
        {saving ? (
          <p role="status" aria-live="polite" className="text-sm text-gray-600">
            {savingLabel}
          </p>
        ) : (
          <PendingStockCommand
            key={scopeKey}
            kind="template"
            hotelUid={hotelUid}
            locationId={locationId}
            templateId={templateId}
            disabled={cannotEdit || query.loading}
            onComplete={() => {
              if (auth.currentUser !== actor) return;
              setError("");
              setSelected(null);
              return query.retry();
            }}
          />
        )}
        {query.loading && !query.data && <Card className="space-y-4">
          <ArticleRowsSkeleton />
        </Card>}
        {query.refreshing && <LoadingStatus>Verifying the updated template…</LoadingStatus>}
        {!canRead && <Card>Location read permission is required to view this template.</Card>}
        {query.error && (
          <div role="alert" className="text-sm text-red-700">
            <p>{query.error.message || "Unable to load stock template."}</p>
            <p>Current article names and revision could not be verified. Editing remains unavailable until the template is reloaded.</p>
            <button type="button" onClick={query.retry} className="underline">
              Retry template
            </button>
          </div>
        )}
        {!query.loading && !query.error && !template && (
          <Card>Stock template not found.</Card>
        )}
        {template && (
          <>
            <Card className="space-y-2">
              <h2 className="text-xl font-semibold">
                {location?.name || "Location name unavailable"} ·{" "}
                {template.name || "Unnamed template"}
              </h2>
              <p className="max-w-3xl text-sm text-gray-600">
                Choose the physical articles you count at this location. An
                inventory-tracked catalog product has counting enabled in
                Catalog Products. Supplier packages remain purchase options;
                counts use each article's catalog base unit. Legacy supplier
                entries require valid catalog links; count creation checks every
                row and reports unresolved links.
              </p>
              {(template.archived === true || location?.archived === true) && (
                <p className="text-sm text-amber-800">
                  This template or location is archived. Historical rows remain
                  visible and cannot be changed.
                </p>
              )}
            </Card>
            <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
              <Card className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-xl font-semibold">Included articles</h2>
                  <span className="text-xs text-gray-500">
                    {items.length} / 250
                  </span>
                </div>
                {items.length === 0 && (
                  <p className="text-sm text-gray-600">
                    No stock template items yet.
                  </p>
                )}
                <ul className="divide-y divide-gray-100">
                  {items.map((item, index) => {
                    const source = displayByKey[itemKey(item)];
                    const label =
                      source?.catalogProductName ||
                      source?.supplierProductName ||
                      "Article name unavailable";
                    const unresolved = !source || source.available === false;
                    return (
                      <li
                        key={`${itemKey(item)}:${index}`}
                        className="flex flex-wrap items-start justify-between gap-3 py-3"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="break-words text-sm font-semibold text-gray-800">
                            {label}
                          </p>
                          <p className="mt-1 text-xs text-gray-500">
                            {item.catalogProductId
                              ? `Catalog article · ${source?.baseUnit ? productUnitLabel(source.baseUnit) : "unit unavailable"}`
                              : `Legacy supplier entry · ${source?.outletName || "outlet name unavailable"}`}
                          </p>
                          {unresolved && (
                            <p
                              role="alert"
                              className="mt-1 text-xs text-amber-800"
                            >
                              This article is unavailable or its legacy catalog
                              link is unresolved. Repair the link or
                              deliberately remove the row; it is not silently
                              omitted.
                            </p>
                          )}
                          {unresolved && (
                            <p className="mt-1 break-all text-xs text-gray-400">
                              Reference:{" "}
                              {item.catalogProductId ||
                                item.supplierProductId ||
                                "missing"}
                            </p>
                          )}
                        </div>
                        <div className="flex gap-1">
                          <button
                            type="button"
                            aria-label={`Move ${label} up`}
                            disabled={disabled || index === 0}
                            onClick={() => move(index, -1)}
                            className="rounded-md border px-2 py-1.5 text-sm disabled:opacity-40"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            aria-label={`Move ${label} down`}
                            disabled={disabled || index === items.length - 1}
                            onClick={() => move(index, 1)}
                            className="rounded-md border px-2 py-1.5 text-sm disabled:opacity-40"
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() =>
                              mutate(() =>
                                removeLocationStockTemplateItem(
                                  hotelUid,
                                  locationId,
                                  templateId,
                                  item,
                                  undefined,
                                  template.revision ?? 0,
                                ),
                                "Removing article…",
                              )
                            }
                            className="rounded-md px-2 py-1.5 text-xs font-medium text-red-700 disabled:opacity-40"
                          >
                            Remove
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </Card>
              <Card className="space-y-4">
                <h2 className="text-xl font-semibold">Add an article</h2>
                <p className="text-sm text-gray-600">
                  Search catalog articles with inventory tracking enabled. Each
                  article appears once in this template.
                </p>
                {!canReadCatalog ? (
                  <p className="rounded-lg bg-gray-50 p-3 text-sm text-gray-600">
                    Catalog read permission is required to choose additional
                    articles. Saved article names remain available through
                    location access.
                  </p>
                ) : (
                  <>
                    <div>
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <label
                        htmlFor="template-catalog-product"
                        className="block text-sm font-medium text-gray-700"
                      >
                        Catalog product
                      </label>
                      {products.hasMore && <button type="button" onMouseDown={(event) => event.preventDefault()}
                        onClick={products.loadMore} disabled={disabled || products.loading}
                        className="text-sm font-medium text-brand-800 underline disabled:opacity-50">Browse more articles</button>}
                      </div>
                      <Combobox
                        id="template-catalog-product"
                        value={selected}
                        options={eligible}
                        onChange={setSelected}
                        displayValue={(product) =>
                          `${product.catalogProductName || product.name || "Unnamed article"} (${productUnitLabel(product.baseUnit)})`
                        }
                        getOptionValue={(product) => product.id}
                        placeholder="Search inventory-tracked articles"
                        disabled={
                          disabled
                        }
                        loading={products.loading}
                        onQueryChange={(value) => { products.search(value); setSelected(null); }}
                        filterOptions={false}
                        maxVisibleOptions={500}
                        emptyMessage="No eligible articles in this page. Refine the search or browse the next page."
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                      />
                    </div>
                    <p className="text-xs text-gray-500">Start typing to find an article, or browse more choices.</p>
                    {products.bounded && <p role="status" className="text-xs text-gray-500">Showing up to 500 articles. Refine the search to find further matches.</p>}
                    {products.error && (
                      <div role="alert" className="text-sm text-red-700">
                        <p>
                          {products.error.message ||
                            "Catalog choices could not be loaded."}
                        </p>
                        <button
                          type="button"
                          onClick={products.retry}
                          className="underline"
                        >
                          Retry catalog choices
                        </button>
                      </div>
                    )}
                    <button
                      type="button"
                      className="rounded-lg bg-brand-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                      disabled={
                        disabled ||
                        !selected ||
                        products.loading ||
                        Boolean(products.error) ||
                        items.length >= 250
                      }
                      onClick={() =>
                        mutate(() =>
                          addLocationStockTemplateItem(
                            hotelUid,
                            locationId,
                            templateId,
                            { catalogProductId: selected.id },
                            template.revision ?? 0,
                          ),
                          "Adding article…",
                        )
                      }
                    >
                      Add product
                    </button>
                  </>
                )}
              </Card>
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
      </ProcurementPage>
    </div>
  );
}
