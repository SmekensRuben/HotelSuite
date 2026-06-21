import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { createAuditUpsell, getUpsellSettings } from "../../services/firebaseUpsells";
import { getSettings } from "../../services/firebaseSettings";

const emptyPackage = () => ({
  packageCode: "",
  startDate: "",
  endDate: "",
  price: "",
});

function getTodayDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function getCurrentTime() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

export default function UpsellCreateAuditPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [form, setForm] = useState({
    logDate: getTodayDateKey(),
    logTime: getCurrentTime(),
    operaUser: "",
    confirmationNumber: "",
    status: "Created",
    fullName: "",
    roomNumber: "",
    arrivalDate: "",
    departureDate: "",
    rateCode: "",
  });
  const [packages, setPackages] = useState([emptyPackage()]);
  const [operaUserOptions, setOperaUserOptions] = useState([]);
  const [packageCodeOptions, setPackageCodeOptions] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const today = useMemo(
    () =>
      new Date().toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
    []
  );

  useEffect(() => {
    let active = true;

    async function loadOptions() {
      if (!hotelUid) {
        setOperaUserOptions([]);
        setPackageCodeOptions([]);
        return;
      }

      try {
        const [settings, upsellSettings] = await Promise.all([
          getSettings(hotelUid),
          getUpsellSettings(hotelUid),
        ]);
        if (!active) return;

        setOperaUserOptions(Object.keys(settings?.operaUserMappings || {}).sort((a, b) => a.localeCompare(b)));
        setPackageCodeOptions((upsellSettings?.packageCodes || []).map((packageCode) => packageCode.packageCode).filter(Boolean));
      } catch (err) {
        console.error("Failed to load audit upsell form options", err);
        if (active) setError("Opera users and packages could not be loaded.");
      }
    }

    loadOptions();

    return () => {
      active = false;
    };
  }, [hotelUid]);

  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  const updateForm = (field, value) => {
    setForm((currentForm) => ({ ...currentForm, [field]: value }));
  };

  const updatePackage = (index, field, value) => {
    setPackages((currentPackages) =>
      currentPackages.map((packageRecord, packageIndex) =>
        packageIndex === index ? { ...packageRecord, [field]: value } : packageRecord
      )
    );
  };

  const addPackage = () => {
    setPackages((currentPackages) => [...currentPackages, emptyPackage()]);
  };

  const removePackage = (index) => {
    setPackages((currentPackages) => currentPackages.filter((_, packageIndex) => packageIndex !== index));
  };

  const validateForm = () => {
    if (!form.logDate) return "Log date is required.";
    if (!form.operaUser.trim()) return "Opera user is required.";
    if (!packages.length) return "At least one package is required.";

    for (const [index, packageRecord] of packages.entries()) {
      if (!packageRecord.packageCode.trim()) return `Package ${index + 1}: package code is required.`;
      if (!packageRecord.startDate) return `Package ${index + 1}: start date is required.`;
      if (!packageRecord.endDate) return `Package ${index + 1}: end date is required.`;
      if (packageRecord.startDate > packageRecord.endDate) return `Package ${index + 1}: end date must be after start date.`;
      if (packageRecord.price === "" || Number.isNaN(Number(packageRecord.price))) return `Package ${index + 1}: price is required.`;
    }

    return "";
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const validationError = validateForm();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError("");

    try {
      const createdRecord = await createAuditUpsell(hotelUid, {
        ...form,
        packages,
        createdBy: auth.currentUser?.email || auth.currentUser?.uid || null,
      });
      navigate(`/front-office/upselling/${createdRecord.dateKey}/${createdRecord.documentId}`, {
        state: { fromUpsellAudit: true },
      });
    } catch (err) {
      console.error("Failed to create audit upsell", err);
      setError("Audit upsell could not be created.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm uppercase tracking-wide text-gray-500">Front Office</p>
            <h1 className="text-3xl font-semibold">Create Audit Upsell</h1>
            <p className="mt-1 text-gray-600">Create a manual audit upsell record with one or more packages.</p>
          </div>
          <button
            type="button"
            onClick={() => navigate("/front-office/upselling/audit")}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
          >
            <ArrowLeft className="h-4 w-4" /> Back to Audit
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}

          <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold text-gray-900">Audit details</h2>
            <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              <label className="text-sm font-medium text-gray-700">Log date
                <input type="date" value={form.logDate} onChange={(e) => updateForm("logDate", e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" required />
              </label>
              <label className="text-sm font-medium text-gray-700">Log time
                <input type="time" value={form.logTime} onChange={(e) => updateForm("logTime", e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
              </label>
              <label className="text-sm font-medium text-gray-700">Opera User
                <input
                  list="create-opera-user-options"
                  value={form.operaUser}
                  onChange={(e) => updateForm("operaUser", e.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
                  placeholder="Search or select an Opera user"
                  required
                />
                <datalist id="create-opera-user-options">
                  {operaUserOptions.map((operaUser) => (
                    <option key={operaUser} value={operaUser} />
                  ))}
                </datalist>
              </label>
              <label className="text-sm font-medium text-gray-700">Confirmation number
                <input value={form.confirmationNumber} onChange={(e) => updateForm("confirmationNumber", e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
              </label>
              <label className="text-sm font-medium text-gray-700">Status
                <input value={form.status} onChange={(e) => updateForm("status", e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
              </label>
              <label className="text-sm font-medium text-gray-700">Guest name
                <input value={form.fullName} onChange={(e) => updateForm("fullName", e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
              </label>
              <label className="text-sm font-medium text-gray-700">Room number
                <input value={form.roomNumber} onChange={(e) => updateForm("roomNumber", e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
              </label>
              <label className="text-sm font-medium text-gray-700">Arrival date
                <input type="date" value={form.arrivalDate} onChange={(e) => updateForm("arrivalDate", e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
              </label>
              <label className="text-sm font-medium text-gray-700">Departure date
                <input type="date" value={form.departureDate} onChange={(e) => updateForm("departureDate", e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
              </label>
              <label className="text-sm font-medium text-gray-700">Rate code
                <input value={form.rateCode} onChange={(e) => updateForm("rateCode", e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
              </label>
            </div>
          </section>

          <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Packages</h2>
                <p className="text-sm text-gray-600">Add one or more packages with separate dates and prices.</p>
              </div>
              <button type="button" onClick={addPackage} className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
                <Plus className="h-4 w-4" /> Add package
              </button>
            </div>

            <div className="mt-4 space-y-4">
              {packages.map((packageRecord, index) => (
                <div key={index} className="rounded-lg border border-gray-200 p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="font-medium text-gray-900">Package {index + 1}</h3>
                    {packages.length > 1 && (
                      <button type="button" onClick={() => removePackage(index)} className="inline-flex items-center gap-1 text-sm font-medium text-red-600 hover:text-red-700">
                        <Trash2 className="h-4 w-4" /> Remove
                      </button>
                    )}
                  </div>
                  <div className="grid gap-4 md:grid-cols-4">
                    <label className="text-sm font-medium text-gray-700">Package code
                      <input
                        list={`create-package-code-options-${index}`}
                        value={packageRecord.packageCode}
                        onChange={(e) => updatePackage(index, "packageCode", e.target.value)}
                        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
                        placeholder="Search or select a package"
                        required
                      />
                      <datalist id={`create-package-code-options-${index}`}>
                        {packageCodeOptions.map((packageCode) => (
                          <option key={packageCode} value={packageCode} />
                        ))}
                      </datalist>
                    </label>
                    <label className="text-sm font-medium text-gray-700">Start date
                      <input type="date" value={packageRecord.startDate} onChange={(e) => updatePackage(index, "startDate", e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" required />
                    </label>
                    <label className="text-sm font-medium text-gray-700">End date
                      <input type="date" value={packageRecord.endDate} onChange={(e) => updatePackage(index, "endDate", e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" required />
                    </label>
                    <label className="text-sm font-medium text-gray-700">Price
                      <input type="number" step="0.01" min="0" value={packageRecord.price} onChange={(e) => updatePackage(index, "price", e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" required />
                    </label>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => navigate("/front-office/upselling/audit")} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-[#981b1b] disabled:cursor-not-allowed disabled:opacity-60">
              <Plus className="h-4 w-4" /> {saving ? "Creating..." : "Create Audit Upsell"}
            </button>
          </div>
        </form>
      </PageContainer>
    </div>
  );
}
