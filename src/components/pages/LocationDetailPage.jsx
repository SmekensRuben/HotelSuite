import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Pencil, Plus } from "lucide-react";
import PendingStockCommand from "../inventory/PendingStockCommand";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import ProcurementResourceArchive from "./ProcurementResourceArchive";
import { Card } from "../layout/Card";
import Modal from "../shared/Modal";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import {
  createLocationStockTemplate,
  getLocationById,
  getLocationStockTemplates,
} from "../../services/firebaseSettings";
import DataListTable from "../shared/DataListTable";
import { usePermission } from "../../hooks/usePermission";
import { ArticleRowsSkeleton } from "../ui/ResourceLoading";

export default function LocationDetailPage() {
  const navigate = useNavigate();
  const { locationId } = useParams();
  const { hotelUid } = useHotelContext();
  const scopeKey = `${hotelUid}:${locationId}`;
  const activeScope = useRef({ key: scopeKey });
  if (activeScope.current.key !== scopeKey)
    activeScope.current = { key: scopeKey };
  const [templateSaving, setTemplateSaving] = useState(false),
    [templateError, setTemplateError] = useState("");
  const canEditLocations = usePermission("locations", "update");
  const canCreateTemplates = usePermission("locations", "create");
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
      loadedScope !== scopeKey
    )
      return;
    const requested = activeScope.current;
    setTemplateSaving(true);
    setTemplateError("");
    try {
      await createLocationStockTemplate(hotelUid, locationId, cleanedName);
      if (activeScope.current !== requested) return;
      const templates = await getLocationStockTemplates(hotelUid, locationId);
      if (activeScope.current !== requested) return;
      setStockTemplates(templates);
      setNewTemplateName("");
      setShowNewTemplateModal(false);
    } catch (error) {
      if (activeScope.current === requested)
        setTemplateError(error.message || "Unable to create stock template.");
    } finally {
      if (activeScope.current === requested) setTemplateSaving(false);
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
    setLoading(Boolean(hotelUid && locationId));
    const loadLocation = async () => {
      if (!hotelUid || !locationId) return;
      try {
        const [locationData, templates] = await Promise.all([
          getLocationById(hotelUid, locationId),
          getLocationStockTemplates(hotelUid, locationId),
        ]);
        if (activeScope.current !== requested) return;
        setLocation(locationData);
        setStockTemplates(templates);
        setLoadedScope(scopeKey);
      } catch (error) {
        if (activeScope.current === requested)
          setTemplateError(
            error.message || "Unable to load location templates.",
          );
      } finally {
        if (activeScope.current === requested) setLoading(false);
      }
    };
    loadLocation();
    return () => {
      activeScope.current = { key: null };
    };
  }, [hotelUid, locationId, scopeKey]);

  const currentLocation = loadedScope === scopeKey ? location : null;
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
                Physical storage and counting location. Stock templates choose
                the catalog articles included in a count.
              </p>
            </div>
            <ProcurementResourceArchive
              hotelUid={hotelUid}
              collection="locations"
              resource={currentLocation}
              onArchived={() => navigate("/settings/locations")}
            />
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
            const requested = activeScope.current;
            const templates = await getLocationStockTemplates(
              hotelUid,
              locationId,
            );
            if (activeScope.current === requested) {
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
            <DataListTable
              columns={[
                { key: "name", label: "Name" },
                { key: "itemCount", label: "Stock Template Items" },
              ]}
              rows={templateRows}
              emptyMessage="No stock templates yet."
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
