import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getFileImportTypes } from "../../services/firebaseSettings";
import { usePermission } from "../../hooks/usePermission";

export default function FileImportTypesPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const canCreateSettings = usePermission("settings", "create");
  const [fileImportTypes, setFileImportTypes] = useState([]);
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
    const loadFileImportTypes = async () => {
      if (!hotelUid) return;
      setLoading(true);
      const result = await getFileImportTypes(hotelUid);
      setFileImportTypes(result);
      setLoading(false);
    };

    loadFileImportTypes();
  }, [hotelUid]);

  const filteredFileImportTypes = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return fileImportTypes.filter((fileImportType) => {
      const searchableValues = [
        fileImportType.fileType,
        fileImportType.parserType,
        fileImportType.targetCollection,
        fileImportType.targetPath,
        fileImportType.writeMode,
      ].map((value) => String(value || "").toLowerCase());

      return !term || searchableValues.some((value) => value.includes(term));
    });
  }, [fileImportTypes, searchTerm]);

  const columns = [
    { key: "fileType", label: "File Type" },
    { key: "parserType", label: "Parser Type" },
    { key: "targetCollection", label: "Target Collection" },
    { key: "writeMode", label: "Write Mode" },
    {
      key: "enabled",
      label: "Enabled",
      render: (row) => (row.enabled ? "Yes" : "No"),
      sortValue: (row) => (row.enabled ? 1 : 0),
    },
  ];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">Settings</p>
            <h1 className="text-3xl font-semibold">File Import Types</h1>
            <p className="text-gray-600 mt-1">Manage file import type definitions per hotel.</p>
          </div>
          <button
            onClick={() => navigate("/settings/file-import-types/new")}
            disabled={!canCreateSettings}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold shadow ${
              canCreateSettings
                ? "bg-[#b41f1f] text-white hover:bg-[#961919]"
                : "bg-gray-300 text-gray-500 cursor-not-allowed"
            }`}
            title="Add file import type"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>

        <div>
          <label className="sr-only" htmlFor="file-import-types-search">
            Search file import types
          </label>
          <input
            id="file-import-types-search"
            type="text"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Search by file type, parser, target collection, target path or write mode"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
          />
        </div>

        {loading ? (
          <p className="text-gray-600">Loading file import types...</p>
        ) : (
          <DataListTable
            columns={columns}
            rows={filteredFileImportTypes}
            emptyMessage="No file import types found."
            onRowClick={(row) => navigate(`/settings/file-import-types/${row.id}`)}
          />
        )}
      </PageContainer>
    </div>
  );
}
