import React, { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { BedDouble, Plus } from "lucide-react";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { addRoomingListReservation, getRoomingListByToken } from "../../services/firebaseRoomingLists";

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

function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(`${value}T00:00:00`));
}

function buildAvailability(group, reservations) {
  const days = Array.isArray(group?.roomTypeDays) ? group.roomTypeDays : [];
  return days.map((day) => {
    const capacity = (day.roomTypes || []).reduce((total, roomType) => total + Number(roomType.quantity || 0), 0);
    const used = reservations.filter((reservation) => {
      const dates = getDateRange(reservation.arrivalDate, reservation.departureDate);
      return dates.includes(day.date);
    }).length;

    return {
      date: day.date,
      capacity,
      used,
      remaining: Math.max(0, capacity - used),
    };
  });
}

export default function RoomingListPage() {
  const { token } = useParams();
  const [roomingList, setRoomingList] = useState(null);
  const [form, setForm] = useState(emptyReservation);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
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
  const availability = useMemo(() => buildAvailability(roomingList?.group, reservations), [roomingList?.group, reservations]);
  const roomTypes = useMemo(() => {
    const unique = new Map();
    (roomingList?.group?.roomTypeDays || []).forEach((day) => {
      (day.roomTypes || []).forEach((roomType) => {
        if (roomType.code) unique.set(roomType.code, `${roomType.code} - ${roomType.name}`);
      });
    });
    return Array.from(unique, ([code, label]) => ({ code, label }));
  }, [roomingList?.group?.roomTypeDays]);
  const filledRooms = reservations.length;
  const totalRooms = availability.reduce((max, day) => Math.max(max, day.capacity), 0);

  const updateForm = (field, value) => setForm((current) => ({ ...current, [field]: value }));

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (saving) return;

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
    } catch (err) {
      setError(err?.message || "Unable to add reservation.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-white via-gray-50 to-gray-100 text-gray-900">
      <PageContainer className="space-y-6 py-8">
        <Card className="border-0 bg-gradient-to-r from-[#b41f1f] via-[#a71c1c] to-[#7f1717] text-white shadow-lg">
          <p className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-red-100">
            <BedDouble className="h-3.5 w-3.5" /> Rooming list
          </p>
          <h1 className="mt-2 text-3xl font-semibold">{roomingList?.groupName || roomingList?.group?.groupName || "Rooming List"}</h1>
          <p className="mt-1 text-sm text-red-100">Status: {roomingList?.status || "Not Started"}</p>
        </Card>

        {loading ? <p className="text-gray-600">Loading rooming list...</p> : error ? <p className="text-sm font-semibold text-red-600">{error}</p> : null}

        {roomingList && (
          <>
            <Card className="border border-gray-100 bg-white/95 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">Overview</h2>
                  <p className="mt-1 text-sm text-gray-600">{filledRooms} of {totalRooms} rooms have been filled in.</p>
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
                    </div>
                  ))}
                </div>
              </div>
            </Card>

            <form onSubmit={handleSubmit} className="grid gap-4 lg:grid-cols-3">
              <Card className="border border-gray-100 bg-white/95 shadow-sm lg:col-span-3">
                <h2 className="text-lg font-semibold">Add Reservation</h2>
                <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Field label="First Name" value={form.firstName} onChange={(value) => updateForm("firstName", value)} required />
                  <Field label="Last Name" value={form.lastName} onChange={(value) => updateForm("lastName", value)} required />
                  <Field label="Arrival Date" type="date" value={form.arrivalDate} min={roomingList.group?.arrival || undefined} max={roomingList.group?.departure || undefined} onChange={(value) => updateForm("arrivalDate", value)} required />
                  <Field label="Departure Date" type="date" value={form.departureDate} min={form.arrivalDate || roomingList.group?.arrival || undefined} max={roomingList.group?.departure || undefined} onChange={(value) => updateForm("departureDate", value)} required />
                  <label className="block text-sm font-medium text-gray-700">
                    Room Type
                    <select value={form.roomType} onChange={(event) => updateForm("roomType", event.target.value)} className="mt-1 w-44 max-w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20" required>
                      <option value="">Select Room Type</option>
                      {roomTypes.map((roomType) => <option key={roomType.code} value={roomType.code}>{roomType.label}</option>)}
                    </select>
                  </label>
                  <Field label="Number of Adults" type="number" min="0" value={form.numberOfAdults} onChange={(value) => updateForm("numberOfAdults", value)} required />
                  <Field label="Number of Children" type="number" min="0" value={form.numberOfChildren} onChange={(value) => updateForm("numberOfChildren", value)} required />
                  <label className="block text-sm font-medium text-gray-700 lg:col-span-2">
                    Comment
                    <textarea value={form.comment} onChange={(event) => updateForm("comment", event.target.value)} className="mt-1 min-h-[2.6rem] w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20" />
                  </label>
                </div>
                <div className="mt-4 flex justify-end">
                  <button type="submit" disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white shadow hover:bg-[#961919] disabled:cursor-not-allowed disabled:bg-gray-300">
                    <Plus className="h-4 w-4" /> {saving ? "Adding..." : "Add Reservation"}
                  </button>
                </div>
              </Card>
            </form>

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
