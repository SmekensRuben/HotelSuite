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
      columnMappings: [
        ...prev.columnMappings,
        {
          sourceField: "",
          databaseField: "",
          targetType: "string",
          seperator: ",",
          importFormat: "",
          targetFormat: "",
        },
      ],
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
