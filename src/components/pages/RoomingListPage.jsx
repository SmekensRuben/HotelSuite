import React, { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { BedDouble, ChevronDown, Plus, Send } from "lucide-react";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { addRoomingListReservation, getRoomingListByToken, submitRoomingList } from "../../services/firebaseRoomingLists";

const emptyReservation = {
  firstName: "",
  lastName: "",
  arrivalDate: "",
  departureDate: "",
  roomType: "",
  numberOfAdults: 1,
  numberOfChildren: 0,
  comment: "",
};

function parseDateParts(value) {
  const [year, month, day] = String(value || "").split("-").map(Number);
  if (!year || !month || !day) return null;
  return { year, month, day };
}

function formatDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getDateRange(startDate, endDate) {
  const startParts = parseDateParts(startDate);
  const endParts = parseDateParts(endDate);
  if (!startParts || !endParts || endDate <= startDate) return [];
  const dates = [];
  const cursor = new Date(startParts.year, startParts.month - 1, startParts.day);
  const end = new Date(endParts.year, endParts.month - 1, endParts.day);
  while (cursor < end) {
    dates.push(formatDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function formatDate(value) {
  const parts = parseDateParts(value);
  if (!parts) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(parts.year, parts.month - 1, parts.day));
}

function buildAvailability(roomingList, reservations) {
  const days = Array.isArray(roomingList?.roomTypeDays) && roomingList.roomTypeDays.length > 0
    ? roomingList.roomTypeDays
    : Array.isArray(roomingList?.group?.roomTypeDays)
      ? roomingList.group.roomTypeDays
      : [];
  return days.map((day) => {
    const roomTypes = (day.roomTypes || []).map((roomType) => {
      const capacity = Number(roomType.quantity || 0);
      const used = reservations.filter((reservation) => {
        const dates = getDateRange(reservation.arrivalDate, reservation.departureDate);
        return dates.includes(day.date) && reservation.roomType === roomType.code;
      }).length;

      return {
        code: roomType.code,
        name: roomType.name,
        capacity,
        used,
        remaining: Math.max(0, capacity - used),
      };
    });
    const capacity = roomTypes.reduce((total, roomType) => total + roomType.capacity, 0);
    const used = roomTypes.reduce((total, roomType) => total + roomType.used, 0);

    return {
      date: day.date,
      roomTypes,
      capacity,
      used,
      remaining: Math.max(0, capacity - used),
    };
  });
}

function findAvailabilityConflict(availability, reservation) {
  const dates = getDateRange(reservation.arrivalDate, reservation.departureDate);
  if (dates.length === 0) return "Select a valid arrival and departure date.";

  for (const date of dates) {
    const day = availability.find((item) => item.date === date);
    const roomType = day?.roomTypes.find((item) => item.code === reservation.roomType);
    if (!roomType || roomType.remaining <= 0) {
      return `No ${reservation.roomType || "selected room type"} rooms are available on ${date}.`;
    }
  }

  return "";
}

export default function RoomingListPage() {
  const { token } = useParams();
  const [roomingList, setRoomingList] = useState(null);
  const [form, setForm] = useState(emptyReservation);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [submittingRoomingList, setSubmittingRoomingList] = useState(false);
  const [isReservationFormOpen, setIsReservationFormOpen] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    async function loadRoomingList() {
      setLoading(true);
      setError("");
      try {
        const result = await getRoomingListByToken(token);
        if (!active) return;
        setRoomingList(result);
        if (!result) setError("Rooming list not found.");
      } catch (err) {
        console.error("Unable to load rooming list:", err);
        if (active) setError(err?.message || "Unable to load rooming list.");
      } finally {
        if (active) setLoading(false);
      }
    }

    loadRoomingList();
    return () => {
      active = false;
    };
  }, [token]);

  const reservations = Array.isArray(roomingList?.reservations) ? roomingList.reservations : [];
  const availability = useMemo(() => buildAvailability(roomingList, reservations), [roomingList, reservations]);
  const roomTypes = useMemo(() => {
    const unique = new Map();
    const publicRoomTypes = Array.isArray(roomingList?.roomTypes) ? roomingList.roomTypes : [];
    publicRoomTypes.forEach((roomType) => {
      if (roomType.code) unique.set(roomType.code, `${roomType.code} - ${roomType.name}`);
    });

    const roomTypeDays = Array.isArray(roomingList?.roomTypeDays) && roomingList.roomTypeDays.length > 0
      ? roomingList.roomTypeDays
      : roomingList?.group?.roomTypeDays || [];

    roomTypeDays.forEach((day) => {
      (day.roomTypes || []).forEach((roomType) => {
        if (roomType.code) unique.set(roomType.code, `${roomType.code} - ${roomType.name}`);
      });
    });
    return Array.from(unique, ([code, label]) => ({ code, label }));
  }, [roomingList?.group?.roomTypeDays, roomingList?.roomTypeDays, roomingList?.roomTypes]);
  const filledRoomNights = availability.reduce((total, day) => total + day.used, 0);
  const totalRoomNights = availability.reduce((total, day) => total + day.capacity, 0);

  const updateForm = (field, value) => setForm((current) => ({ ...current, [field]: value }));

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (saving) return;

    if (roomingList?.status === "Submitted") {
      setError("This rooming list has already been submitted.");
      return;
    }

    const availabilityConflict = findAvailabilityConflict(availability, form);
    if (availabilityConflict) {
      setError(availabilityConflict);
      return;
    }

    setSaving(true);
    setError("");
    try {
      const reservation = await addRoomingListReservation(token, form);
      setRoomingList((current) => ({
        ...current,
        status: "Concept",
        reservations: [...(current?.reservations || []), reservation],
      }));
      setForm(emptyReservation);
      setIsReservationFormOpen(false);
    } catch (err) {
      setError(err?.message || "Unable to add reservation.");
    } finally {
      setSaving(false);
    }
  };


  const handleSubmitRoomingList = async () => {
    if (submittingRoomingList || roomingList?.status === "Submitted") return;

    setSubmittingRoomingList(true);
    setError("");
    try {
      await submitRoomingList(token);
      setRoomingList((current) => ({
        ...current,
        status: "Submitted",
      }));
      setIsReservationFormOpen(false);
    } catch (err) {
      setError(err?.message || "Unable to submit rooming list.");
    } finally {
      setSubmittingRoomingList(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-white via-gray-50 to-gray-100 text-gray-900">
      <PageContainer className="space-y-6 py-8">
        <Card className="border-0 bg-gradient-to-r from-[#b41f1f] via-[#a71c1c] to-[#7f1717] text-white shadow-lg">
          <p className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-red-100">
            <BedDouble className="h-3.5 w-3.5" /> Rooming list
          </p>
          <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-3xl font-semibold">{roomingList?.groupName || roomingList?.group?.groupName || "Rooming List"}</h1>
              <p className="mt-4 inline-flex rounded-full bg-white/15 px-4 py-2 text-lg font-semibold text-white">Status: {roomingList?.status || "Not Started"}</p>
            </div>
            {roomingList && (
              <button
                type="button"
                onClick={handleSubmitRoomingList}
                disabled={submittingRoomingList || roomingList.status === "Submitted"}
                className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-[#b41f1f] shadow hover:bg-red-50 disabled:cursor-not-allowed disabled:bg-white/40 disabled:text-white/70"
              >
                <Send className="h-4 w-4" /> {submittingRoomingList ? "Submitting..." : roomingList.status === "Submitted" ? "Submitted" : "Submit Rooming List"}
              </button>
            )}
          </div>
        </Card>

        {loading ? <p className="text-gray-600">Loading rooming list...</p> : error ? <p className="text-sm font-semibold text-red-600">{error}</p> : null}

        {roomingList && (
          <>
            <Card className="border border-gray-100 bg-white/95 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">Overview</h2>
                  <p className="mt-1 text-sm text-gray-600">{filledRoomNights} of {totalRoomNights} room nights have been filled in.</p>
                </div>
              </div>
              <div className="mt-4 overflow-x-auto pb-2">
                <div className="grid auto-cols-[minmax(12rem,1fr)] grid-flow-col gap-3">
                  {availability.map((day) => (
                    <div key={day.date} className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                      <p className="text-sm font-semibold text-gray-900">{formatDate(day.date)}</p>
                      <p className="mt-2 text-xs text-gray-500">Filled: {day.used}</p>
                      <p className="text-xs text-gray-500">Available: {day.remaining}</p>
                      <p className="text-xs text-gray-500">Total: {day.capacity}</p>
                      <div className="mt-3 space-y-2">
                        {day.roomTypes.map((roomType) => (
                          <div key={`${day.date}-${roomType.code}`} className="rounded-lg bg-white px-2 py-1.5 text-xs shadow-sm">
                            <p className="font-semibold text-gray-800">{roomType.code} - {roomType.name}</p>
                            <p className="text-gray-500">{roomType.used} filled / {roomType.remaining} available</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>

            <Card className="overflow-hidden border border-gray-100 bg-white/95 p-0 shadow-sm">
              <button
                type="button"
                onClick={() => setIsReservationFormOpen((current) => !current)}
                disabled={roomingList.status === "Submitted"}
                className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left hover:bg-gray-50 disabled:cursor-not-allowed disabled:bg-gray-50"
              >
                <div>
                  <h2 className="text-lg font-semibold">Add Reservation</h2>
                  <p className="mt-1 text-sm text-gray-600">
                    {roomingList.status === "Submitted" ? "This rooming list has been submitted and can no longer be changed." : "Open the form to add another reservation to this rooming list."}
                  </p>
                </div>
                <ChevronDown className={`h-5 w-5 text-gray-500 transition-transform ${isReservationFormOpen ? "rotate-180" : ""}`} />
              </button>

              {isReservationFormOpen && roomingList.status !== "Submitted" && (
                <form onSubmit={handleSubmit} className="border-t border-gray-100 bg-gradient-to-b from-white to-gray-50 px-5 py-5">
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <Field label="First Name" value={form.firstName} onChange={(value) => updateForm("firstName", value)} required />
                    <Field label="Last Name" value={form.lastName} onChange={(value) => updateForm("lastName", value)} required />
                    <Field label="Arrival Date" type="date" value={form.arrivalDate} min={roomingList.arrival || roomingList.group?.arrival || undefined} max={roomingList.departure || roomingList.group?.departure || undefined} onChange={(value) => updateForm("arrivalDate", value)} required />
                    <Field label="Departure Date" type="date" value={form.departureDate} min={form.arrivalDate || roomingList.arrival || roomingList.group?.arrival || undefined} max={roomingList.departure || roomingList.group?.departure || undefined} onChange={(value) => updateForm("departureDate", value)} required />
                    <div className="pt-6">
                      <select
                        value={form.roomType}
                        onChange={(event) => updateForm("roomType", event.target.value)}
                        className="w-44 max-w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
                        aria-label="Room Type"
                        required
                      >
                        <option value="">Select Room Type</option>
                        {roomTypes.map((roomType) => <option key={roomType.code} value={roomType.code}>{roomType.label}</option>)}
                      </select>
                    </div>
                    <Field label="Number of Adults" type="number" min="0" value={form.numberOfAdults} onChange={(value) => updateForm("numberOfAdults", value)} required />
                    <Field label="Number of Children" type="number" min="0" value={form.numberOfChildren} onChange={(value) => updateForm("numberOfChildren", value)} required />
                    <label className="block text-sm font-medium text-gray-700 lg:col-span-2">
                      Comment
                      <textarea value={form.comment} onChange={(event) => updateForm("comment", event.target.value)} className="mt-1 min-h-[4.5rem] w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20" />
                    </label>
                  </div>
                  <div className="mt-5 flex justify-end">
                    <button type="submit" disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white shadow hover:bg-[#961919] disabled:cursor-not-allowed disabled:bg-gray-300">
                      <Plus className="h-4 w-4" /> {saving ? "Adding..." : "Add Reservation"}
                    </button>
                  </div>
                </form>
              )}
            </Card>

            <Card className="border border-gray-100 bg-white/95 shadow-sm">
              <h2 className="text-lg font-semibold">Reservations</h2>
              <div className="mt-4 overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 text-sm">
                  <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                    <tr>
                      <th className="px-3 py-2">Guest</th>
                      <th className="px-3 py-2">Arrival</th>
                      <th className="px-3 py-2">Departure</th>
                      <th className="px-3 py-2">Room Type</th>
                      <th className="px-3 py-2">Adults</th>
                      <th className="px-3 py-2">Children</th>
                      <th className="px-3 py-2">Comment</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 bg-white">
                    {reservations.length === 0 ? (
                      <tr><td className="px-3 py-4 text-gray-500" colSpan="7">No reservations have been added yet.</td></tr>
                    ) : reservations.map((reservation) => (
                      <tr key={reservation.id}>
                        <td className="px-3 py-2 font-medium text-gray-900">{reservation.firstName} {reservation.lastName}</td>
                        <td className="px-3 py-2 text-gray-700">{reservation.arrivalDate}</td>
                        <td className="px-3 py-2 text-gray-700">{reservation.departureDate}</td>
                        <td className="px-3 py-2 text-gray-700">{reservation.roomType}</td>
                        <td className="px-3 py-2 text-gray-700">{reservation.numberOfAdults}</td>
                        <td className="px-3 py-2 text-gray-700">{reservation.numberOfChildren}</td>
                        <td className="px-3 py-2 text-gray-700">{reservation.comment || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </PageContainer>
    </div>
  );
}

function Field({ label, type = "text", value, onChange, ...props }) {
  return (
    <label className="block text-sm font-medium text-gray-700">
      {label}
      <input
        type={type}
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
        {...props}
      />
    </label>
  );
}
