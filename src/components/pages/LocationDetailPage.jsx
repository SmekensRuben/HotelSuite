import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Pencil, Plus } from "lucide-react";
import PendingStockCommand from "../inventory/PendingStockCommand";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import ProcurementResourceArchive from "./ProcurementResourceArchive";
import { Card } from "../layout/Card";
import Modal from "../shared/Modal";
import { auth, signOut } from "../../firebaseConfig";
import { useProcurementSettingsScope } from "../../hooks/useProcurementSettingsScope";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import {
  createLocationStockTemplate,
  getLocationById,
  getLocationStockTemplates,
  getOutletById,
} from "../../services/firebaseSettings";
import DataListTable from "../shared/DataListTable";
import { usePermission } from "../../hooks/usePermission";
import { ArticleRowsSkeleton } from "../ui/ResourceLoading";

export default function LocationDetailPage() {
  const navigate = useNavigate();
  const { locationId } = useParams();
  const scope = useProcurementSettingsScope();
  const { hotelUid, current } = scope;
  const scopeKey = `${scope.scopeKey}:${locationId}`;
  const activeScope = useRef({ key: scopeKey });
  if (activeScope.current.key !== scopeKey)
    activeScope.current = { key: scopeKey };
  const [templateSaving, setTemplateSaving] = useState(false),
    [templateError, setTemplateError] = useState("");
  const canEditLocations = usePermission("locations", "update");
  const canCreateTemplates = usePermission("locations", "create");
  const canReadLocations = usePermission("locations", "read");
  const canReadOutlets = usePermission("outlets", "read");
  const [location, setLocation] = useState(null);
  const [loadedScope, setLoadedScope] = useState(null);
  const [loading, setLoading] = useState(true);
  const [stockTemplates, setStockTemplates] = useState([]);
  const [showNewTemplateModal, setShowNewTemplateModal] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");

  const today = useMemo(
    () =>
      new Date().toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
    [],
  );
  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  const handleCreateStockTemplate = async () => {
    const cleanedName = newTemplateName.trim();
    if (
      !cleanedName ||
      !canCreateTemplates ||
      templateSaving ||
      location?.archived === true ||
      loadedScope !== scopeKey ||
      !current()
    )
      return;
    const requested = activeScope.current;
    setTemplateSaving(true);
    setTemplateError("");
    try {
      await createLocationStockTemplate(hotelUid, locationId, cleanedName);
      if (activeScope.current !== requested || !current()) return;
      const templates = await getLocationStockTemplates(hotelUid, locationId);
      if (activeScope.current !== requested || !current()) return;
      setStockTemplates(templates);
      setNewTemplateName("");
      setShowNewTemplateModal(false);
    } catch (error) {
      if (activeScope.current === requested && current())
        setTemplateError(error.message || "Unable to create stock template.");
    } finally {
      if (activeScope.current === requested && current()) setTemplateSaving(false);
    }
  };

  useEffect(() => {
    activeScope.current = { key: scopeKey };
    const requested = activeScope.current;
    setTemplateSaving(false);
    setTemplateError("");
    setShowNewTemplateModal(false);
    setNewTemplateName("");
    setLocation(null);
    setStockTemplates([]);
    setLoading(Boolean(hotelUid && locationId && canReadLocations));
    const loadLocation = async () => {
      if (!hotelUid || !locationId || !canReadLocations) return;
      try {
        const [locationData, templates] = await Promise.all([
          getLocationById(hotelUid, locationId),
          getLocationStockTemplates(hotelUid, locationId),
        ]);
        if (activeScope.current !== requested || !current()) return;
        setLocation(locationData);
        setStockTemplates(templates);
        setLoadedScope(scopeKey);
      } catch (error) {
        if (activeScope.current === requested && current())
          setTemplateError(
            error.message || "Unable to load location templates.",
          );
      } finally {
        if (activeScope.current === requested && current()) setLoading(false);
      }
    };
    loadLocation();
    return () => {
      activeScope.current = { key: null };
    };
  }, [hotelUid, locationId, scopeKey, canReadLocations, current]);

  const currentLocation = loadedScope === scopeKey ? location : null;
  const isOutletStockPoint = currentLocation?.stockPointType === "outlet" || String(locationId || "").startsWith("outlet:");
  const parentOutletId = currentLocation?.outletId;
  const loadParentOutlet = useCallback(async () => {
    const outlet = await getOutletById(hotelUid, parentOutletId);
    if (!current()) throw new Error("Hotel access changed. Reload locations.");
    return outlet;
  }, [hotelUid, parentOutletId, current]);
  const parentOutlet = useScopedAsync({ scopeKey: `${scopeKey}:${parentOutletId || ""}:${canReadOutlets}`, enabled: Boolean(parentOutletId && canReadOutlets), load: loadParentOutlet });
  const templateRows = (loadedScope === scopeKey ? stockTemplates : []).map(
    (template) => ({
      ...template,
      itemCount: Array.isArray(template.items) ? template.items.length : 0,
    }),
  );

  return (
    <div className="min-h-screen bg-canvas text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <ProcurementPage className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-3xl font-semibold">Location Detail</h1>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => navigate("/settings/locations")}
              className="inline-flex items-center justify-center rounded border border-gray-300 p-2 text-gray-700 hover:bg-gray-100"
              title="Back to locations"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => navigate(`/settings/locations/${locationId}/edit`)}
              disabled={
                !canEditLocations ||
                currentLocation?.archived === true ||
                isOutletStockPoint ||
                !currentLocation
              }
              className={`inline-flex items-center justify-center rounded border p-2 ${canEditLocations ? "border-gray-300 text-gray-700 hover:bg-gray-100" : "border-gray-200 text-gray-500 cursor-not-allowed"}`}
              title="Edit location"
            >
              <Pencil className="h-4 w-4" />
            </button>
          </div>
        </div>
        {loading ? (
          <Card><ArticleRowsSkeleton rows={3} label="Preparing location and stock templates…" /></Card>
        ) : !currentLocation ? (
          <Card>
            <p className="text-gray-600">Location not found.</p>
          </Card>
        ) : (
          <Card className="space-y-4">
            <div>
              <h2 className="text-2xl font-semibold">
                {currentLocation.name || "Unnamed location"}
              </h2>
              <p className="mt-2 text-sm text-gray-600">
                {isOutletStockPoint ? "This stock point represents the whole outlet. Manage its name and status in Outlet settings. Stock templates are optional shortcuts."
                  : "Optional detail within an outlet. Count the outlet directly or use this location when more detail helps. Stock templates are optional shortcuts."}
              </p>
              <div className="mt-3 text-sm text-gray-600">
                <span className="font-medium text-gray-900">Outlet: </span>
                {!parentOutletId ? "Unassigned location" : !canReadOutlets ? "Linked outlet" : parentOutlet.loading ? "Loading outlet..." : parentOutlet.data ?
                  <Link to={`/settings/outlets/${parentOutletId}`} className="font-medium text-brand-900 underline underline-offset-2">{parentOutlet.data.name}{parentOutlet.data.archived === true ? " (archived)" : ""}</Link> : "Outlet unavailable"}
                {parentOutlet.error && <button type="button" onClick={parentOutlet.retry} className="ml-2 underline">Retry outlet</button>}
              </div>
            </div>
            {!isOutletStockPoint && <ProcurementResourceArchive
              hotelUid={hotelUid}
              collection="locations"
              resource={currentLocation}
              onArchived={() => { if (current()) navigate("/settings/locations"); }}
            />}
          </Card>
        )}

        <PendingStockCommand
          hotelUid={hotelUid}
          locationId={locationId}
          disabled={
            !canCreateTemplates ||
            !currentLocation ||
            templateSaving ||
            currentLocation?.archived === true
          }
          onComplete={async () => {
            if (!current()) return;
            const requested = activeScope.current;
            const templates = await getLocationStockTemplates(
              hotelUid,
              locationId,
            );
            if (activeScope.current === requested && current()) {
              setStockTemplates(templates);
              setNewTemplateName("");
              setShowNewTemplateModal(false);
              setTemplateError("");
            }
          }}
        />
        {!loading && currentLocation && (
          <Card>
            <div className="mb-3 flex flex-wrap items-center justify-between">
              <h3 className="text-lg font-semibold">Stock Templates</h3>
              <button
                type="button"
                disabled={
                  !canCreateTemplates ||
                  !currentLocation ||
                  templateSaving ||
                  currentLocation?.archived === true
                }
                onClick={() => setShowNewTemplateModal(true)}
                className="inline-flex items-center gap-2 rounded border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
              >
                <Plus className="h-4 w-4" />
                New Stock Template
              </button>
            </div>
            <p className="mb-4 text-sm text-gray-600">Optional starting lists for repeat counts. You can also add products while counting.</p>
            <DataListTable
              columns={[
                { key: "name", label: "Name" },
                { key: "itemCount", label: "Stock Template Items" },
              ]}
              rows={templateRows}
              emptyMessage="No templates yet. You can count without a template."
              onRowClick={(row) =>
                navigate(
                  `/settings/locations/${locationId}/stock-templates/${row.id}`,
                )
              }
            />
          </Card>
        )}
        {templateError && (
          <p role="alert" className="text-red-700">
            {templateError}
          </p>
        )}
      </ProcurementPage>
      <Modal
        open={showNewTemplateModal}
        onClose={() => setShowNewTemplateModal(false)}
        title="New Stock Template"
      >
        <div className="space-y-3">
          <input
            type="text"
            aria-label="Stock template name"
            disabled={templateSaving}
            value={newTemplateName}
            onChange={(event) => setNewTemplateName(event.target.value)}
            placeholder="Stock template name"
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
          {templateError && (
            <p role="alert" className="text-red-700">
              {templateError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rounded border border-gray-300 px-3 py-2 text-sm"
              onClick={() => setShowNewTemplateModal(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded bg-brand-800 px-3 py-2 text-sm text-white disabled:opacity-60"
              disabled={
                !canCreateTemplates ||
                templateSaving ||
                currentLocation?.archived === true ||
                !newTemplateName.trim()
              }
              onClick={handleCreateStockTemplate}
            >
              Save
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
