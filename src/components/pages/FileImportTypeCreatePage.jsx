import React, { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { createFileImportType } from "../../services/firebaseSettings";
import FileImportTypeForm, { initialFileImportTypeValues } from "./FileImportTypeForm.jsx";

export default function FileImportTypeCreatePage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [formValues, setFormValues] = useState(initialFileImportTypeValues);
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
    setFormValues((prev) => ({
      ...prev,
      columnMappings: updateMappingsAtPath(prev.columnMappings, path, (currentValue) => {
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
    if (!hotelUid || !formValues.fileType.trim()) return;

    setSaving(true);
    const created = await createFileImportType(hotelUid, {
      ...formValues,
      createdBy: auth.currentUser?.uid || "unknown",
    });
    setSaving(false);

    if (created?.id) {
      navigate(`/settings/file-import-types/${created.id}`);
      return;
    }

    navigate("/settings/file-import-types");
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div>
          <p className="text-sm text-gray-500 uppercase tracking-wide">Settings</p>
          <h1 className="text-3xl font-semibold">Create File Import Type</h1>
        </div>

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
            onCancel={() => navigate("/settings/file-import-types")}
            saving={saving}
            submitLabel="Save File Import Type"
          />
        </Card>
      </PageContainer>
    </div>
  );
}
