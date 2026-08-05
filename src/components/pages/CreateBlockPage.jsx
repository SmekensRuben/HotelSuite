import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, BedDouble, Plus, Trash2 } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { calculateBlockedRooms, createGroup } from "../../services/firebaseGroups";
import { getSettings } from "../../services/firebaseSettings";

const emptyForm = {
  groupName: "",
  blockCode: "",
  arrival: "",
  departure: "",
  roomingListDeadline: "",
  meOfficer: "",
  organiserName: "",
  organiserEmail: "",
  organiserPhone: "",
};

function getDateRange(startDate, endDate) {
  if (!startDate || !endDate || endDate < startDate) return [];

  const dates = [];
  const cursor = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);

  while (cursor < end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setDate(cursor.getDate() + 1);
  }

  return dates;
}

function createRoomTypeDays(arrival, departure, existingDays) {
  const existingByDate = new Map(existingDays.map((day) => [day.date, day]));

  return getDateRange(arrival, departure).map((date) => {
    const existingDay = existingByDate.get(date);
    return {
      date,
      roomTypes: existingDay?.roomTypes?.length ? existingDay.roomTypes : [],
    };
  });
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(`${value}T00:00:00`));
}

export default function CreateBlockPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [form, setForm] = useState(emptyForm);
  const [roomTypeDays, setRoomTypeDays] = useState([]);
  const [configuredRoomTypes, setConfiguredRoomTypes] = useState([]);
  const [loadingRoomTypes, setLoadingRoomTypes] = useState(true);
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

  const blockedRooms = useMemo(() => calculateBlockedRooms(roomTypeDays), [roomTypeDays]);

  useEffect(() => {
    let active = true;

    async function loadRoomTypes() {
      if (!hotelUid) {
        setConfiguredRoomTypes([]);
        setLoadingRoomTypes(false);
        return;
      }

      setLoadingRoomTypes(true);
      try {
        const settings = await getSettings(hotelUid);
        if (!active) return;
        const roomTypes = Array.isArray(settings?.roomTypes)
          ? settings.roomTypes
              .map((roomType, index) => {
                const code = String(roomType?.code || "").trim();
                const description = String(roomType?.description || "").trim();
                const amount = Number(roomType?.amount);
                return {
                  id: String(roomType?.id || code || `room-type-${index}`),
                  code,
                  description,
                  amount: Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0,
                };
              })
              .filter((roomType) => roomType.code && roomType.description)
          : [];
        setConfiguredRoomTypes(roomTypes);
      } catch (err) {
        console.error("Fout bij laden van Room Types:", err);
        if (active) setError("Room Types konden niet geladen worden uit General Settings.");
      } finally {
        if (active) setLoadingRoomTypes(false);
      }
    }

    loadRoomTypes();

    return () => {
      active = false;
    };
  }, [hotelUid]);

  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  const updateFormField = (field, value) => {
    setForm((current) => {
      const next = { ...current, [field]: value };
      if (field === "arrival" || field === "departure") {
        setRoomTypeDays((days) => createRoomTypeDays(next.arrival, next.departure, days));
      }
      return next;
    });
  };

  const addRoomType = (date) => {
    setRoomTypeDays((days) =>
      days.map((day) =>
        day.date === date
          ? {
              ...day,
              roomTypes: [...day.roomTypes, { id: `${date}-${Date.now()}`, code: "", name: "", quantity: 0 }],
            }
          : day
      )
    );
  };

  const updateRoomType = (date, roomTypeId, field, value) => {
    const selectedRoomType = field === "configuredRoomTypeId"
      ? configuredRoomTypes.find((roomType) => roomType.id === value)
      : null;

    setRoomTypeDays((days) =>
      days.map((day) =>
        day.date === date
          ? {
              ...day,
              roomTypes: day.roomTypes.map((roomType) =>
                roomType.id === roomTypeId
                  ? selectedRoomType
                    ? {
                        ...roomType,
                        configuredRoomTypeId: selectedRoomType.id,
                        code: selectedRoomType.code,
                        name: selectedRoomType.description,
                        quantity: selectedRoomType.amount,
                      }
                    : { ...roomType, [field]: value }
                  : roomType
              ),
            }
          : day
      )
    );
  };

  const removeRoomType = (date, roomTypeId) => {
    setRoomTypeDays((days) =>
      days.map((day) =>
        day.date === date
          ? { ...day, roomTypes: day.roomTypes.filter((roomType) => roomType.id !== roomTypeId) }
          : day
      )
    );
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!hotelUid || saving) return;

    setSaving(true);
    setError("");
    try {
      await createGroup(
        hotelUid,
        {
          ...form,
          roomTypeDays,
        },
        auth.currentUser?.uid || "unknown"
      );
      navigate("/me/groups");
    } catch (err) {
      setError(err?.message || "Unable to create group.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-white via-gray-50 to-gray-100 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6 pb-10">
        <Card className="border-0 bg-gradient-to-r from-[#b41f1f] via-[#a71c1c] to-[#7f1717] text-white shadow-lg">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-2">
              <p className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-red-100">
                <BedDouble className="h-3.5 w-3.5" /> M&amp;E block management
              </p>
              <h1 className="text-3xl font-semibold">Create Group</h1>
              <p className="max-w-2xl text-sm text-red-100">
                Create a group block with daily room type allowances and organiser contacts.
              </p>
            </div>
            <button
              type="button"
              onClick={() => navigate("/me/groups")}
              className="inline-flex items-center gap-2 rounded-lg border border-white/30 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/20"
            >
              <ArrowLeft className="h-4 w-4" /> Back to Groups
            </button>
          </div>
        </Card>

        <form onSubmit={handleSubmit} className="grid gap-4 lg:grid-cols-3">
          <Card className="border border-gray-100 bg-white/95 shadow-sm lg:col-span-2">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Group Name" value={form.groupName} onChange={(value) => updateFormField("groupName", value)} required />
              <Field label="Block Code" value={form.blockCode} onChange={(value) => updateFormField("blockCode", value)} required />
              <Field label="Arrival" type="date" value={form.arrival} onChange={(value) => updateFormField("arrival", value)} required />
              <Field label="Departure" type="date" value={form.departure} onChange={(value) => updateFormField("departure", value)} min={form.arrival || undefined} required />
              <Field label="Rooming List Deadline" type="date" value={form.roomingListDeadline} onChange={(value) => updateFormField("roomingListDeadline", value)} required />
              <Field label="Blocked Rooms" type="number" value={blockedRooms} readOnly />
              <Field label="M&E Officer" value={form.meOfficer} onChange={(value) => updateFormField("meOfficer", value)} required />
              <Field label="Organiser Name" value={form.organiserName} onChange={(value) => updateFormField("organiserName", value)} required />
              <Field label="Organiser Email" type="email" value={form.organiserEmail} onChange={(value) => updateFormField("organiserEmail", value)} required />
              <Field label="Organiser Phone" value={form.organiserPhone} onChange={(value) => updateFormField("organiserPhone", value)} />
            </div>
          </Card>

          <Card className="border border-gray-100 bg-white/95 shadow-sm">
            <div>
              <h2 className="text-lg font-semibold">Allowed Room Types</h2>
              <p className="mt-1 text-sm text-gray-600">
                Select the allowed Room Types from General Settings. Quantity is filled from the configured amount
                automatically.
              </p>
            </div>
            <div className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-[#b41f1f]">
              Total Blocked Rooms: {blockedRooms}
            </div>
          </Card>

          <Card className="border border-gray-100 bg-white/95 shadow-sm lg:col-span-3">
            <div className="space-y-5">
              {roomTypeDays.length === 0 ? (
                <p className="text-sm text-gray-600">Select an arrival and departure date to add daily room type allowances.</p>
              ) : (
                roomTypeDays.map((day) => (
                  <div key={day.date} className="rounded-xl border border-gray-200 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h3 className="font-semibold text-gray-900">{formatDate(day.date)}</h3>
                        <p className="text-xs text-gray-500">{day.date}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => addRoomType(day.date)}
                        className="inline-flex items-center gap-1 rounded-lg border border-[#b41f1f] px-3 py-2 text-sm font-semibold text-[#b41f1f] hover:bg-red-50"
                      >
                        <Plus className="h-4 w-4" /> Add Room Type
                      </button>
                    </div>

                    <div className="mt-4 space-y-3">
                      {day.roomTypes.map((roomType) => (
                        <div key={roomType.id} className="grid grid-cols-[1fr_7rem_auto] items-end gap-2">
                          <label className="block text-sm font-medium text-gray-700">
                            Room Type
                            <select
                              value={roomType.configuredRoomTypeId || ""}
                              onChange={(event) => updateRoomType(day.date, roomType.id, "configuredRoomTypeId", event.target.value)}
                              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
                              required
                            >
                              <option value="">Select Room Type</option>
                              {configuredRoomTypes.map((configuredRoomType) => (
                                <option key={configuredRoomType.id} value={configuredRoomType.id}>
                                  {configuredRoomType.code} - {configuredRoomType.description} ({configuredRoomType.amount})
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="block text-sm font-medium text-gray-700">
                            Quantity
                            <input
                              type="number"
                              min="0"
                              value={roomType.quantity}
                              readOnly
                              className="mt-1 w-full rounded-lg border border-gray-300 bg-gray-100 px-3 py-2 text-sm text-gray-700 focus:outline-none"
                              required
                            />
                          </label>
                          <button
                            type="button"
                            onClick={() => removeRoomType(day.date, roomType.id)}
                            className="mb-0.5 rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-[#b41f1f]"
                            aria-label={`Remove ${roomType.name || "room type"}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </Card>

          {error && <p className="text-sm font-semibold text-red-600 lg:col-span-3">{error}</p>}

          <div className="flex justify-end gap-3 lg:col-span-3">
            <button
              type="button"
              onClick={() => navigate("/me/groups")}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || roomTypeDays.length === 0 || loadingRoomTypes || configuredRoomTypes.length === 0}
              className={`rounded-lg px-4 py-2 text-sm font-semibold text-white shadow ${
                saving || roomTypeDays.length === 0 || loadingRoomTypes || configuredRoomTypes.length === 0
                  ? "bg-gray-300 cursor-not-allowed"
                  : "bg-[#b41f1f] hover:bg-[#961919]"
              }`}
            >
              {saving ? "Creating Group..." : "Create Group"}
            </button>
          </div>
        </form>
      </PageContainer>
    </div>
  );
}

function Field({ label, type = "text", value, onChange, readOnly = false, ...props }) {
  return (
    <label className="block text-sm font-medium text-gray-700">
      {label}
      <input
        type={type}
        value={value}
        readOnly={readOnly}
        onChange={(event) => onChange?.(event.target.value)}
        className={`mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20 ${
          readOnly ? "bg-gray-100 text-gray-700" : ""
        }`}
        {...props}
      />
    </label>
  );
}
