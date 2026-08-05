import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, BedDouble, Plus, Trash2 } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { calculateBlockedRooms, createGroup, getGroup, updateGroup } from "../../services/firebaseGroups";
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
      roomTypes: existingDay?.roomTypes?.length
        ? existingDay.roomTypes.map((roomType, index) => ({
            id: roomType.id || `${date}-${roomType.code || "room-type"}-${index}`,
            configuredRoomTypeId: roomType.configuredRoomTypeId || roomType.code || "",
            code: roomType.code || "",
            name: roomType.name || "",
            quantity: roomType.quantity || 0,
            maxQuantity: roomType.maxQuantity ?? roomType.quantity ?? 0,
          }))
        : [],
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

export default function CreateBlockPage({ mode = "create" }) {
  const navigate = useNavigate();
  const { groupId } = useParams();
  const { hotelUid } = useHotelContext();
  const [form, setForm] = useState(emptyForm);
  const [roomTypeDays, setRoomTypeDays] = useState([]);
  const [configuredRoomTypes, setConfiguredRoomTypes] = useState([]);
  const [loadingRoomTypes, setLoadingRoomTypes] = useState(true);
  const [loadingGroup, setLoadingGroup] = useState(mode === "edit");
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

  const isEditMode = mode === "edit";
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
        console.error("Unable to load Room Types:", err);
        if (active) setError("Room Types could not be loaded from General Settings.");
      } finally {
        if (active) setLoadingRoomTypes(false);
      }
    }

    loadRoomTypes();

    return () => {
      active = false;
    };
  }, [hotelUid]);

  useEffect(() => {
    let active = true;

    async function loadGroup() {
      if (!isEditMode) {
        setLoadingGroup(false);
        return;
      }

      if (!hotelUid || !groupId) return;

      setLoadingGroup(true);
      try {
        const group = await getGroup(hotelUid, groupId);
        if (!active) return;
        if (!group) {
          setError("Group not found.");
          return;
        }

        setForm({
          groupName: group.groupName || "",
          blockCode: group.blockCode || "",
          arrival: group.arrival || "",
          departure: group.departure || "",
          roomingListDeadline: group.roomingListDeadline || "",
          meOfficer: group.meOfficer || "",
          organiserName: group.organiserName || "",
          organiserEmail: group.organiserEmail || "",
          organiserPhone: group.organiserPhone || "",
        });
        setRoomTypeDays(createRoomTypeDays(group.arrival || "", group.departure || "", group.roomTypeDays || []));
      } catch (err) {
        console.error("Unable to load group:", err);
        if (active) setError(err?.message || "Unable to load group.");
      } finally {
        if (active) setLoadingGroup(false);
      }
    }

    loadGroup();

    return () => {
      active = false;
    };
  }, [groupId, hotelUid, isEditMode]);

  useEffect(() => {
    if (configuredRoomTypes.length === 0) return;

    setRoomTypeDays((days) =>
      days.map((day) => ({
        ...day,
        roomTypes: day.roomTypes.map((roomType) => {
          const configuredRoomType = configuredRoomTypes.find(
            (item) => item.id === roomType.configuredRoomTypeId || item.code === roomType.code
          );

          if (!configuredRoomType) return roomType;

          return {
            ...roomType,
            configuredRoomTypeId: configuredRoomType.id,
            code: configuredRoomType.code,
            name: configuredRoomType.description,
            maxQuantity: configuredRoomType.amount,
          };
        }),
      }))
    );
  }, [configuredRoomTypes]);

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
              roomTypes: [...day.roomTypes, { id: `${date}-${Date.now()}`, code: "", name: "", quantity: 0, maxQuantity: 0 }],
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
                        quantity: Math.min(Number(roomType.quantity) || 0, selectedRoomType.amount),
                        maxQuantity: selectedRoomType.amount,
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

  const hasInvalidRoomQuantity = () =>
    roomTypeDays.some((day) =>
      day.roomTypes.some((roomType) => {
        const quantity = Number(roomType.quantity);
        const maxQuantity = Number(roomType.maxQuantity);
        return (
          !Number.isFinite(quantity) ||
          quantity < 0 ||
          (Number.isFinite(maxQuantity) && maxQuantity >= 0 && quantity > maxQuantity)
        );
      })
    );

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!hotelUid || saving) return;

    if (hasInvalidRoomQuantity()) {
      setError("Quantity cannot be higher than the Amount in General Settings.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      const payload = {
        ...form,
        roomTypeDays,
      };

      if (isEditMode) {
        await updateGroup(hotelUid, groupId, payload, auth.currentUser?.uid || "unknown");
        navigate(`/me/groups/${groupId}`);
      } else {
        await createGroup(hotelUid, payload, auth.currentUser?.uid || "unknown");
        navigate("/me/groups");
      }
    } catch (err) {
      setError(err?.message || (isEditMode ? "Unable to update group." : "Unable to create group."));
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
              <h1 className="text-3xl font-semibold">{isEditMode ? "Edit Group" : "Create Group"}</h1>
              <p className="max-w-2xl text-sm text-red-100">
                {isEditMode ? "Update a group block with daily room type allowances and organiser contacts." : "Create a group block with daily room type allowances and organiser contacts."}
              </p>
            </div>
            <button
              type="button"
              onClick={() => navigate(isEditMode ? `/me/groups/${groupId}` : "/me/groups")}
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
                Select the allowed Room Types from General Settings. Quantity can be set per group up to the
                configured maximum amount.
              </p>
            </div>
            <div className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-[#b41f1f]">
              Total Blocked Rooms: {blockedRooms}
            </div>
          </Card>

          <Card className="border border-gray-100 bg-white/95 shadow-sm lg:col-span-3">
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold">Daily Room Type Allowances</h2>
                <p className="mt-1 text-sm text-gray-600">Scroll horizontally to review each day in the group block.</p>
              </div>
              {roomTypeDays.length === 0 ? (
                <p className="text-sm text-gray-600">Select an arrival and departure date to add daily room type allowances.</p>
              ) : (
                <div className="overflow-x-auto pb-2">
                  <div className="grid auto-cols-[minmax(17rem,1fr)] grid-flow-col gap-4">
                    {roomTypeDays.map((day) => (
                      <div key={day.date} className="rounded-xl border border-gray-200 bg-gray-50/60 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <h3 className="font-semibold text-gray-900">{formatDate(day.date)}</h3>
                            <p className="text-xs text-gray-500">{day.date}</p>
                          </div>
                          <span className="rounded-full bg-red-50 px-2.5 py-1 text-xs font-semibold text-[#b41f1f]">
                            {day.roomTypes.reduce((total, roomType) => total + Number(roomType.quantity || 0), 0)} rooms
                          </span>
                        </div>

                        <div className="mt-4 space-y-3">
                          {day.roomTypes.map((roomType) => (
                            <div key={roomType.id} className="rounded-lg border border-gray-200 bg-white p-3">
                              <label className="block text-sm font-medium text-gray-700">
                                Room Type
                                <select
                                  value={roomType.configuredRoomTypeId || ""}
                                  onChange={(event) => updateRoomType(day.date, roomType.id, "configuredRoomTypeId", event.target.value)}
                                  className="mt-1 w-44 max-w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
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
                              <label className="mt-3 block text-sm font-medium text-gray-700">
                                Quantity
                                <input
                                  type="number"
                                  min="0"
                                  value={roomType.quantity}
                                  max={roomType.maxQuantity ?? undefined}
                                  onChange={(event) => updateRoomType(day.date, roomType.id, "quantity", event.target.value)}
                                  className="mt-1 w-24 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
                                  required
                                />
                                <span className="ml-2 text-xs text-gray-500">Max {roomType.maxQuantity ?? 0}</span>
                              </label>
                              <button
                                type="button"
                                onClick={() => removeRoomType(day.date, roomType.id)}
                                className="mt-3 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-gray-500 hover:bg-gray-100 hover:text-[#b41f1f]"
                                aria-label={`Remove ${roomType.name || "room type"}`}
                              >
                                <Trash2 className="h-4 w-4" /> Remove
                              </button>
                            </div>
                          ))}
                          <button
                            type="button"
                            onClick={() => addRoomType(day.date)}
                            className="inline-flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-[#b41f1f] px-3 py-2 text-sm font-semibold text-[#b41f1f] hover:bg-red-50"
                          >
                            <Plus className="h-4 w-4" /> Add Room Type
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
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
              disabled={saving || loadingGroup || roomTypeDays.length === 0 || loadingRoomTypes || configuredRoomTypes.length === 0}
              className={`rounded-lg px-4 py-2 text-sm font-semibold text-white shadow ${
                saving || loadingGroup || roomTypeDays.length === 0 || loadingRoomTypes || configuredRoomTypes.length === 0
                  ? "bg-gray-300 cursor-not-allowed"
                  : "bg-[#b41f1f] hover:bg-[#961919]"
              }`}
            >
              {saving ? (isEditMode ? "Saving Group..." : "Creating Group...") : (isEditMode ? "Save Group" : "Create Group")}
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
