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
          idFormat: Array.isArray(data.idFormat) ? data.idFormat : [],
          targetDateSourceType: data.targetDateSourceType || "currentDate",
          targetDateSourceField: data.targetDateSourceField || "",
          targetDateOffsetDays:
            data.targetDateOffsetDays === null || data.targetDateOffsetDays === undefined
              ? "0"
              : String(data.targetDateOffsetDays),
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
              ? data.columnMappings.map(function normalizeMapping(mapping) {
                  return {
                    sourceField: mapping?.sourceField || mapping?.csvHeader || "",
                    databaseField: mapping?.databaseField || "",
                    targetType: mapping?.targetType || "string",
                    seperator: mapping?.seperator || ",",
                    importFormat: mapping?.importFormat || "",
                    targetFormat: mapping?.targetFormat || "",
                    childMappings: Array.isArray(mapping?.childMappings)
                      ? mapping.childMappings.map(normalizeMapping)
                      : [],
                  };
                })
              : [
                  createEmptyMapping(),
                ],
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

  const handleIdFormatToggle = (databaseField) => {
    setFormValues((prev) => {
      const currentValues = Array.isArray(prev.idFormat) ? prev.idFormat : [];
      const nextValues = currentValues.includes(databaseField)
        ? currentValues.filter((value) => value !== databaseField)
        : [...currentValues, databaseField];

      return {
        ...prev,
        idFormat: nextValues,
      };
    });
  };

  const createEmptyMapping = () => ({
    sourceField: "",
    databaseField: "",
    targetType: "string",
    seperator: ",",
    importFormat: "",
    targetFormat: "",
    childMappings: [],
  });

  const updateMappingsAtPath = (mappings, path, updater) => {
    if (!Array.isArray(mappings)) return mappings;
    if (path.length === 0) return updater(mappings);

    const [segment, ...rest] = path;
    if (typeof segment !== 'number') return mappings;

    return mappings.map((mapping, index) => {
      if (index !== segment) return mapping;
      if (rest.length === 0) return updater(mapping);

      const [nextSegment, ...nestedRest] = rest;
      if (nextSegment !== 'childMappings') return mapping;

      return {
        ...mapping,
        childMappings: updateMappingsAtPath(
          Array.isArray(mapping.childMappings) ? mapping.childMappings : [],
          nestedRest,
          updater
        ),
      };
    });
  };

  const handleMappingChange = (path, field) => (event) => {
    const value = event.target.value;
    setFormValues((prev) => ({
      ...prev,
      columnMappings: updateMappingsAtPath(prev.columnMappings, path, (mapping) => ({
        ...mapping,
        [field]: value,
        ...(field === 'targetType' && value !== 'list' ? { childMappings: [] } : {}),
      })),
    }));
  };

  const handleAddMapping = (path = []) => {
    const normalizedPath = Array.isArray(path) ? path : [];

    setFormValues((prev) => ({
      ...prev,
      columnMappings: updateMappingsAtPath(prev.columnMappings, normalizedPath, (currentValue) => {
        if (Array.isArray(currentValue)) {
          return [...currentValue, createEmptyMapping()];
        }
        return currentValue;
      }),
    }));
  };

  const handleRemoveMapping = (path) => {
    if (!Array.isArray(path) || path.length === 0) return;
    const targetIndex = path[path.length - 1];
    const parentPath = path.slice(0, -1);

    setFormValues((prev) => ({
      ...prev,
      columnMappings: updateMappingsAtPath(prev.columnMappings, parentPath, (currentValue) => {
        if (!Array.isArray(currentValue) || currentValue.length <= 1) return currentValue;
        return currentValue.filter((_, mappingIndex) => mappingIndex !== targetIndex);
      }),
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
              onIdFormatToggle={handleIdFormatToggle}
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
