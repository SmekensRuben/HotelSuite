import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { createFileImportType } from "../../services/firebaseSettings";
import FileImportTypeFormFields from "./FileImportTypeFormFields";

const initialValues = {
  fileType: "",
  parserType: "",
  delimiter: ",",
  hasHeaderRow: true,
  targetCollection: "",
  writeMode: "",
  enabled: true,
};

export default function FileImportTypeCreatePage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [formValues, setFormValues] = useState(initialValues);
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
    const nextValue = event?.target?.type === "checkbox" ? event.target.checked : event.target.value;
    setFormValues((prev) => ({ ...prev, [field]: nextValue }));
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
          <form onSubmit={handleSubmit} className="space-y-4">
            <FileImportTypeFormFields formValues={formValues} onChange={handleChange} />

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => navigate("/settings/file-import-types")}
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
      </PageContainer>
    </div>
  );
}
