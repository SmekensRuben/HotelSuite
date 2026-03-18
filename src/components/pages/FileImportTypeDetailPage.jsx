import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Pencil, Trash2 } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import Modal from "../shared/Modal";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { deleteFileImportType, getFileImportTypeById } from "../../services/firebaseSettings";
import { usePermission } from "../../hooks/usePermission";

function DetailField({ label, value }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-sm text-gray-800 mt-1 break-words">{value || "-"}</p>
    </div>
  );
}

export default function FileImportTypeDetailPage() {
  const navigate = useNavigate();
  const { fileImportTypeId } = useParams();
  const { hotelUid } = useHotelContext();
  const canUpdateSettings = usePermission("settings", "update");
  const canDeleteSettings = usePermission("settings", "delete");
  const [fileImportType, setFileImportType] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

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
    const loadFileImportType = async () => {
      if (!hotelUid || !fileImportTypeId) return;
      setLoading(true);
      const data = await getFileImportTypeById(hotelUid, fileImportTypeId);
      setFileImportType(data);
      setLoading(false);
    };

    loadFileImportType();
  }, [hotelUid, fileImportTypeId]);

  const handleDelete = async () => {
    if (!hotelUid || !fileImportTypeId || !canDeleteSettings) return;
    await deleteFileImportType(hotelUid, fileImportTypeId);
    setShowDeleteModal(false);
    navigate("/settings/file-import-types");
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">Settings</p>
            <h1 className="text-3xl font-semibold">File Import Type Detail</h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate(`/settings/file-import-types/${fileImportTypeId}/edit`)}
              disabled={!canUpdateSettings}
              className={`inline-flex items-center justify-center rounded border p-2 ${
                canUpdateSettings
                  ? "border-gray-300 text-gray-700 hover:bg-gray-100"
                  : "border-gray-200 text-gray-400 cursor-not-allowed"
              }`}
              title="Edit file import type"
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setShowDeleteModal(true)}
              disabled={!canDeleteSettings}
              className={`inline-flex items-center justify-center rounded border p-2 ${
                canDeleteSettings
                  ? "border-red-200 text-red-700 hover:bg-red-50"
                  : "border-gray-200 text-gray-400 cursor-not-allowed"
              }`}
              title="Delete file import type"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>

        {loading ? (
          <p className="text-gray-600">Loading file import type...</p>
        ) : !fileImportType ? (
          <Card>
            <p className="text-gray-600">File import type not found.</p>
          </Card>
        ) : (
          <div className="space-y-6">
            <Card>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <DetailField label="File Type" value={fileImportType.fileType} />
                <DetailField label="Parser Type" value={fileImportType.parserType} />
                <DetailField label="Delimiter" value={fileImportType.delimiter} />
                <DetailField label="Has Header Row" value={fileImportType.hasHeaderRow ? "Yes" : "No"} />
                <DetailField label="Target Collection" value={fileImportType.targetCollection} />
                <DetailField label="Base Path" value={fileImportType.basePath} />
                <DetailField label="Target Path" value={fileImportType.targetPath} />
                <DetailField
                  label="Date Source"
                  value={
                    fileImportType.targetDateSourceType === "databaseField"
                      ? `Database Field: ${fileImportType.targetDateSourceField || "-"}`
                      : "Current Date"
                  }
                />
                <DetailField label="Write Mode" value={fileImportType.writeMode} />
                <DetailField label="Enabled" value={fileImportType.enabled ? "Yes" : "No"} />
              </div>
            </Card>

            <Card>
              <div className="space-y-4">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">Column Mappings</h2>
                  <p className="text-sm text-gray-500">Configured CSV header to database field mappings.</p>
                </div>

                {fileImportType.columnMappings.length === 0 ? (
                  <p className="text-sm text-gray-500">No column mappings configured.</p>
                ) : (
                  <div className="overflow-hidden rounded-xl border border-gray-200">
                    <table className="min-w-full divide-y divide-gray-200 bg-white">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                            CSV Header
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                            Database Field
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {fileImportType.columnMappings.map((mapping, index) => (
                          <tr key={`${mapping.csvHeader}-${mapping.databaseField}-${index}`}>
                            <td className="px-4 py-3 text-sm text-gray-700">{mapping.csvHeader || "-"}</td>
                            <td className="px-4 py-3 text-sm text-gray-700">{mapping.databaseField || "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </Card>
          </div>
        )}
      </PageContainer>

      <Modal
        open={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        title="Delete file import type"
      >
        <p className="text-sm text-gray-700">Are you sure you want to delete this file import type?</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setShowDeleteModal(false)}
            className="px-4 py-2 rounded border border-gray-300 text-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={!canDeleteSettings}
            className={`px-4 py-2 rounded ${
              canDeleteSettings
                ? "bg-red-600 text-white hover:bg-red-700"
                : "bg-gray-300 text-gray-500 cursor-not-allowed"
            }`}
          >
            Delete
          </button>
        </div>
      </Modal>
    </div>
  );
}
