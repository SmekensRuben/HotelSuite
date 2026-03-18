import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getFileImportTypeById, updateFileImportType } from "../../services/firebaseSettings";
import FileImportTypeFormFields from "./FileImportTypeFormFields";

const initialValues = {
  fileType: "",
  parserType: "",
  delimiter: ",",
  hasHeaderRow: true,
  targetCollection: "",
  targetPath: "",
  writeMode: "",
  enabled: true,
  columnsMappings: [],
};

export default function FileImportTypeEditPage() {
  const navigate = useNavigate();
  const { fileImportTypeId } = useParams();
  const { hotelUid } = useHotelContext();
  const [formValues, setFormValues] = useState(initialValues);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

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
      if (result) {
        setFormValues({
          fileType: result.fileType || "",
          parserType: result.parserType || "",
          delimiter: result.delimiter || ",",
          hasHeaderRow: Boolean(result.hasHeaderRow),
          targetCollection: result.targetCollection || "",
          targetPath: result.targetPath || "",
          writeMode: result.writeMode || "",
          enabled: Boolean(result.enabled),
          columnsMappings: Array.isArray(result.columnsMappings) ? result.columnsMappings : [],
        });
      }
      setLoading(false);
    };

    loadFileImportType();
  }, [hotelUid, fileImportTypeId]);

  const handleChange = (field, index, key) => (event) => {
    if (field === "addColumnMapping") {
      setFormValues((prev) => ({
        ...prev,
        columnsMappings: [...prev.columnsMappings, { csvHeader: "", databaseField: "" }],
      }));
      return;
    }

    if (field === "removeColumnMapping") {
      setFormValues((prev) => ({
        ...prev,
        columnsMappings: prev.columnsMappings.filter((_, mappingIndex) => mappingIndex !== index),
      }));
      return;
    }

    if (field === "columnMappingField") {
      const nextValue = event?.target?.value || "";
      setFormValues((prev) => ({
        ...prev,
        columnsMappings: prev.columnsMappings.map((mapping, mappingIndex) =>
          mappingIndex === index ? { ...mapping, [key]: nextValue } : mapping
        ),
      }));
      return;
    }

    const nextValue = event?.target?.type === "checkbox" ? event.target.checked : event.target.value;
    setFormValues((prev) => ({ ...prev, [field]: nextValue }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!hotelUid || !fileImportTypeId || !formValues.fileType.trim()) return;

    setSaving(true);
    await updateFileImportType(hotelUid, fileImportTypeId, {
      ...formValues,
      updatedBy: auth.currentUser?.uid || "unknown",
    });
    setSaving(false);
    navigate(`/settings/file-import-types/${fileImportTypeId}`);
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div>
          <p className="text-sm text-gray-500 uppercase tracking-wide">Settings</p>
          <h1 className="text-3xl font-semibold">Edit File Import Type</h1>
        </div>

        {loading ? (
          <p className="text-gray-600">Loading file import type...</p>
        ) : (
          <Card>
            <form onSubmit={handleSubmit} className="space-y-4">
              <FileImportTypeFormFields formValues={formValues} onChange={handleChange} />

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => navigate(`/settings/file-import-types/${fileImportTypeId}`)}
                  className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium hover:bg-gray-100"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 rounded-lg bg-[#b41f1f] text-white text-sm font-semibold hover:bg-[#961919] disabled:opacity-60"
                >
                  {saving ? "Saving..." : "Save File Import Type"}
                </button>
              </div>
            </form>
          </Card>
        )}
      </PageContainer>
    </div>
  );
}
