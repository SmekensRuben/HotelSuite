import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import {
  getFileImportSettingById,
  updateFileImportSetting,
} from "../../services/firebaseSettings";

const initialValues = {
  reportName: "",
  fromEmail: "",
  toEmail: "",
  subject: "",
  fileType: "",
};

export default function FileImportSettingEditPage() {
  const navigate = useNavigate();
  const { fileImportSettingId } = useParams();
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
    const loadFileImportSetting = async () => {
      if (!hotelUid || !fileImportSettingId) return;
      setLoading(true);
      const data = await getFileImportSettingById(hotelUid, fileImportSettingId);
      if (data) {
        setFormValues({
          reportName: data.reportName || "",
          fromEmail: data.fromEmail || "",
          toEmail: data.toEmail || "",
          subject: data.subject || "",
          fileType: data.fileType || "",
        });
      }
      setLoading(false);
    };

    loadFileImportSetting();
  }, [hotelUid, fileImportSettingId]);

  const handleChange = (field) => (event) => {
    setFormValues((prev) => ({ ...prev, [field]: event.target.value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!hotelUid || !fileImportSettingId || !formValues.reportName.trim()) return;

    setSaving(true);
    await updateFileImportSetting(hotelUid, fileImportSettingId, {
      ...formValues,
      updatedBy: auth.currentUser?.uid || "unknown",
    });
    setSaving(false);
    navigate(`/settings/file-import/${fileImportSettingId}`);
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div>
          <p className="text-sm text-gray-500 uppercase tracking-wide">Settings</p>
          <h1 className="text-3xl font-semibold">Edit File Import Setting</h1>
        </div>

        {loading ? (
          <p className="text-gray-600">Loading file import setting...</p>
        ) : (
          <Card>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="report-name" className="block text-sm font-medium text-gray-700 mb-1">
                  Report Name
                </label>
                <input
                  id="report-name"
                  type="text"
                  value={formValues.reportName}
                  onChange={handleChange("reportName")}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  required
                />
              </div>

              <div>
                <label htmlFor="from-email" className="block text-sm font-medium text-gray-700 mb-1">
                  From Email
                </label>
                <input
                  id="from-email"
                  type="email"
                  value={formValues.fromEmail}
                  onChange={handleChange("fromEmail")}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label htmlFor="to-email" className="block text-sm font-medium text-gray-700 mb-1">
                  To Email
                </label>
                <input
                  id="to-email"
                  type="email"
                  value={formValues.toEmail}
                  onChange={handleChange("toEmail")}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label htmlFor="subject" className="block text-sm font-medium text-gray-700 mb-1">
                  Subject
                </label>
                <input
                  id="subject"
                  type="text"
                  value={formValues.subject}
                  onChange={handleChange("subject")}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label htmlFor="file-type" className="block text-sm font-medium text-gray-700 mb-1">
                  File Type
                </label>
                <input
                  id="file-type"
                  type="text"
                  value={formValues.fileType}
                  onChange={handleChange("fileType")}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  placeholder="csv"
                />
              </div>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => navigate(`/settings/file-import/${fileImportSettingId}`)}
                  className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium hover:bg-gray-100"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 rounded-lg bg-[#b41f1f] text-white text-sm font-semibold hover:bg-[#961919] disabled:opacity-60"
                >
                  {saving ? "Saving..." : "Save File Import Setting"}
                </button>
              </div>
            </form>
          </Card>
        )}
      </PageContainer>
    </div>
  );
}
