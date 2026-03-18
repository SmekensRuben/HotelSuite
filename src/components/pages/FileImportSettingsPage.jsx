import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getFileImportSettings } from "../../services/firebaseSettings";
import { usePermission } from "../../hooks/usePermission";

export default function FileImportSettingsPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const canCreateSettings = usePermission("settings", "create");
  const [fileImportSettings, setFileImportSettings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");

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
    const loadFileImportSettings = async () => {
      if (!hotelUid) return;
      setLoading(true);
      const result = await getFileImportSettings(hotelUid);
      setFileImportSettings(result);
      setLoading(false);
    };

    loadFileImportSettings();
  }, [hotelUid]);

  const filteredSettings = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return fileImportSettings.filter((setting) => {
      const reportName = String(setting.reportName || "").toLowerCase();
      const fromEmail = String(setting.fromEmail || "").toLowerCase();
      const toEmail = String(setting.toEmail || "").toLowerCase();
      const subjectContains = String(setting.subjectContains || "").toLowerCase();
      const fileType = String(setting.fileType || "").toLowerCase();
      return (
        !term ||
        reportName.includes(term) ||
        fromEmail.includes(term) ||
        toEmail.includes(term) ||
        subjectContains.includes(term) ||
        fileType.includes(term)
      );
    });
  }, [fileImportSettings, searchTerm]);

  const columns = [
    { key: "reportName", label: "Report Name" },
    { key: "fromEmail", label: "From Email" },
    { key: "toEmail", label: "To Email" },
    { key: "subjectContains", label: "Subject Contains" },
    { key: "fileType", label: "File Type" },
  ];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">Settings</p>
            <h1 className="text-3xl font-semibold">File Import Settings</h1>
            <p className="text-gray-600 mt-1">Manage file import rules per hotel.</p>
          </div>
          <button
            onClick={() => navigate("/settings/file-import/new")}
            disabled={!canCreateSettings}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold shadow ${
              canCreateSettings
                ? "bg-[#b41f1f] text-white hover:bg-[#961919]"
                : "bg-gray-300 text-gray-500 cursor-not-allowed"
            }`}
            title="Add file import setting"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>

        <div>
          <label className="sr-only" htmlFor="file-import-search">
            Search file import settings
          </label>
          <input
            id="file-import-search"
            type="text"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Search by report, emails, subject contains or type"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
          />
        </div>

        {loading ? (
          <p className="text-gray-600">Loading file import settings...</p>
        ) : (
          <DataListTable
            columns={columns}
            rows={filteredSettings}
            emptyMessage="No file import settings found."
            onRowClick={(row) => navigate(`/settings/file-import/${row.id}`)}
          />
        )}
      </PageContainer>
    </div>
  );
}
