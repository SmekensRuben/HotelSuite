import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getFileImportTypeById, updateFileImportType } from "../../services/firebaseSettings";
import FileImportTypeForm, { initialFileImportTypeValues } from "./FileImportTypeForm.jsx";

export default function FileImportTypeEditPage() {
  const navigate = useNavigate();
  const { fileImportTypeId } = useParams();
  const { hotelUid } = useHotelContext();
  const [formValues, setFormValues] = useState(initialFileImportTypeValues);
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
      const data = await getFileImportTypeById(hotelUid, fileImportTypeId);
      if (data) {
        setFormValues({
          fileType: data.fileType || "",
          parserType: data.parserType || "",
          delimiter: data.delimiter || "",
          hasHeaderRow: Boolean(data.hasHeaderRow),
          targetCollection: data.targetCollection || "",
          basePath: data.basePath || "",
          targetPath: data.targetPath || "",
          targetDateSourceType: data.targetDateSourceType || "currentDate",
          targetDateSourceField: data.targetDateSourceField || "",
          recordParsingMode: data.recordParsingMode || "auto",
          recordNodeName: data.recordNodeName || "",
          expectedColumnCount:
            data.expectedColumnCount === null || data.expectedColumnCount === undefined
              ? ""
              : String(data.expectedColumnCount),
          writeMode: data.writeMode || "",
          enabled: Boolean(data.enabled),
          columnMappings:
            Array.isArray(data.columnMappings) && data.columnMappings.length > 0
              ? data.columnMappings.map((mapping) => ({
                  sourceField: mapping?.sourceField || mapping?.csvHeader || "",
                  databaseField: mapping?.databaseField || "",
                }))
              : [{ sourceField: "", databaseField: "" }],
        });
      }
      setLoading(false);
    };

    loadFileImportType();
  }, [hotelUid, fileImportTypeId]);

  const handleChange = (field) => (event) => {
    setFormValues((prev) => ({ ...prev, [field]: event.target.value }));
  };

  const handleToggle = (field) => (event) => {
    setFormValues((prev) => ({ ...prev, [field]: event.target.checked }));
  };

  const handleMappingChange = (index, field) => (event) => {
    const value = event.target.value;
    setFormValues((prev) => ({
      ...prev,
      columnMappings: prev.columnMappings.map((mapping, mappingIndex) =>
        mappingIndex === index ? { ...mapping, [field]: value } : mapping
      ),
    }));
  };

  const handleAddMapping = () => {
    setFormValues((prev) => ({
      ...prev,
      columnMappings: [...prev.columnMappings, { sourceField: "", databaseField: "" }],
    }));
  };

  const handleRemoveMapping = (index) => {
    setFormValues((prev) => ({
      ...prev,
      columnMappings: prev.columnMappings.filter((_, mappingIndex) => mappingIndex !== index),
    }));
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
            <FileImportTypeForm
              formValues={formValues}
              onChange={handleChange}
              onToggle={handleToggle}
              onMappingChange={handleMappingChange}
              onAddMapping={handleAddMapping}
              onRemoveMapping={handleRemoveMapping}
              onSubmit={handleSubmit}
              onCancel={() => navigate(`/settings/file-import-types/${fileImportTypeId}`)}
              saving={saving}
              submitLabel="Save File Import Type"
            />
          </Card>
        )}
      </PageContainer>
    </div>
  );
}
