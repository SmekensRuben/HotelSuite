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

function DetailRow({ label, value }) {
  return (
    <div className="grid gap-1 border-b border-gray-100 py-3 sm:grid-cols-[220px_1fr] sm:gap-4">
      <dt className="text-sm font-medium text-gray-500">{label}</dt>
      <dd className="text-sm text-gray-900 break-words">{value || "-"}</dd>
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
  const [deleting, setDeleting] = useState(false);
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
      const result = await getFileImportTypeById(hotelUid, fileImportTypeId);
      setFileImportType(result);
      setLoading(false);
    };

    loadFileImportType();
  }, [hotelUid, fileImportTypeId]);

  const handleDelete = async () => {
    if (!hotelUid || !fileImportTypeId) return;
    setDeleting(true);
    await deleteFileImportType(hotelUid, fileImportTypeId);
    setDeleting(false);
    setShowDeleteModal(false);
    navigate("/settings/file-import-types");
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">Settings</p>
            <h1 className="text-3xl font-semibold">File Import Type Detail</h1>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate(`/settings/file-import-types/${fileImportTypeId}/edit`)}
              disabled={!canUpdateSettings || !fileImportType}
              className="inline-flex rounded-lg border border-gray-300 bg-white p-2 text-gray-700 shadow-sm hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              title="Edit file import type"
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setShowDeleteModal(true)}
              disabled={!canDeleteSettings || !fileImportType}
              className="inline-flex rounded-lg border border-red-200 bg-white p-2 text-red-600 shadow-sm hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
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
            <p className="text-sm text-gray-600">File import type not found.</p>
          </Card>
        ) : (
          <Card>
            <dl>
              <DetailRow label="File Type" value={fileImportType.fileType} />
              <DetailRow label="Parser Type" value={fileImportType.parserType} />
              <DetailRow label="Delimiter" value={fileImportType.delimiter} />
              <DetailRow
                label="Has Header Row"
                value={fileImportType.hasHeaderRow ? "Yes" : "No"}
              />
              <DetailRow label="Target Collection" value={fileImportType.targetCollection} />
              <DetailRow label="Target Path" value={fileImportType.targetPath} />
              <DetailRow label="Write Mode" value={fileImportType.writeMode} />
              <DetailRow label="Enabled" value={fileImportType.enabled ? "Yes" : "No"} />
            </dl>

            <div className="mt-6">
              <h2 className="text-sm font-semibold text-gray-900">Column Mappings</h2>
              <div className="mt-3 overflow-hidden rounded-lg border border-gray-200">
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
                    {fileImportType.columnsMappings.length === 0 ? (
                      <tr>
                        <td className="px-4 py-4 text-sm text-gray-500" colSpan={2}>
                          No column mappings configured.
                        </td>
                      </tr>
                    ) : (
                      fileImportType.columnsMappings.map((mapping, index) => (
                        <tr key={`${mapping.csvHeader}-${mapping.databaseField}-${index}`}>
                          <td className="px-4 py-3 text-sm text-gray-700">{mapping.csvHeader || "-"}</td>
                          <td className="px-4 py-3 text-sm text-gray-700">{mapping.databaseField || "-"}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </Card>
        )}

        <Modal
          open={showDeleteModal}
          onClose={() => !deleting && setShowDeleteModal(false)}
          title="Delete File Import Type"
          actions={
            <>
              <button
                type="button"
                onClick={() => setShowDeleteModal(false)}
                disabled={deleting}
                className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium hover:bg-gray-100 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="px-4 py-2 rounded-lg bg-[#b41f1f] text-white text-sm font-semibold hover:bg-[#961919] disabled:opacity-60"
              >
                {deleting ? "Deleting..." : "Delete"}
              </button>
            </>
          }
        >
          <p className="text-sm text-gray-600">
            Are you sure you want to delete this file import type?
          </p>
        </Modal>
      </PageContainer>
    </div>
  );
}
