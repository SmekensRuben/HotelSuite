import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Pencil, Trash2 } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import Modal from "../shared/Modal";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import {
  deleteFileImportSetting,
  getFileImportSettingById,
} from "../../services/firebaseSettings";
import { usePermission } from "../../hooks/usePermission";

function DetailField({ label, value }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-sm text-gray-800 mt-1">{value || "-"}</p>
    </div>
  );
}

export default function FileImportSettingDetailPage() {
  const navigate = useNavigate();
  const { fileImportSettingId } = useParams();
  const { hotelUid } = useHotelContext();
  const canUpdateSettings = usePermission("settings", "update");
  const canDeleteSettings = usePermission("settings", "delete");
  const [fileImportSetting, setFileImportSetting] = useState(null);
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
    const loadFileImportSetting = async () => {
      if (!hotelUid || !fileImportSettingId) return;
      setLoading(true);
      const data = await getFileImportSettingById(hotelUid, fileImportSettingId);
      setFileImportSetting(data);
      setLoading(false);
    };

    loadFileImportSetting();
  }, [hotelUid, fileImportSettingId]);

  const handleDelete = async () => {
    if (!hotelUid || !fileImportSettingId || !canDeleteSettings) return;
    await deleteFileImportSetting(hotelUid, fileImportSettingId);
    setShowDeleteModal(false);
    navigate("/settings/file-import");
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-3xl font-semibold">File Import Setting Detail</h1>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate(`/settings/file-import/${fileImportSettingId}/edit`)}
              disabled={!canUpdateSettings}
              className={`inline-flex items-center justify-center rounded border p-2 ${
                canUpdateSettings
                  ? "border-gray-300 text-gray-700 hover:bg-gray-100"
                  : "border-gray-200 text-gray-400 cursor-not-allowed"
              }`}
              title="Edit file import setting"
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
              title="Delete file import setting"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>

        {loading ? (
          <p className="text-gray-600">Loading file import setting...</p>
        ) : !fileImportSetting ? (
          <Card>
            <p className="text-gray-600">File import setting not found.</p>
          </Card>
        ) : (
          <Card>
            <div className="grid gap-4 sm:grid-cols-2">
              <DetailField label="Report Name" value={fileImportSetting.reportName} />
              <DetailField label="From Email" value={fileImportSetting.fromEmail} />
              <DetailField label="To Email" value={fileImportSetting.toEmail} />
              <DetailField label="Subject" value={fileImportSetting.subject} />
              <DetailField label="File Type" value={fileImportSetting.fileType} />
            </div>
          </Card>
        )}
      </PageContainer>

      <Modal
        open={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        title="Delete file import setting"
      >
        <p className="text-sm text-gray-700">Are you sure you want to delete this file import setting?</p>
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
