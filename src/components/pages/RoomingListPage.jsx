import React, { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BedDouble,
  Pencil,
  Plus,
  Search,
  Send,
  Trash2,
  X,
} from "lucide-react";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import {
  addRoomingListReservation,
  cancelRoomingListChangeRequest,
  createRoomingListChangeRequest,
  deleteRoomingListReservation,
  getRoomingListByToken,
  submitRoomingList,
  submitRoomingListChangeRequest,
  updateRoomingListReservation,
} from "../../services/firebaseRoomingLists";

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
  const [year, month, day] = String(value || "")
    .split("-")
    .map(Number);
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
  const cursor = new Date(
    startParts.year,
    startParts.month - 1,
    startParts.day,
  );
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
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(parts.year, parts.month - 1, parts.day));
}

function buildAvailability(roomingList, reservations) {
  const days =
    Array.isArray(roomingList?.roomTypeDays) &&
    roomingList.roomTypeDays.length > 0
      ? roomingList.roomTypeDays
      : Array.isArray(roomingList?.group?.roomTypeDays)
        ? roomingList.group.roomTypeDays
        : [];
  return days.map((day) => {
    const roomTypes = (day.roomTypes || []).map((roomType) => {
      const capacity = Number(roomType.quantity || 0);
      const used = reservations.filter((reservation) => {
        const dates = getDateRange(
          reservation.arrivalDate,
          reservation.departureDate,
        );
        return (
          dates.includes(day.date) && reservation.roomType === roomType.code
        );
      }).length;

      return {
        code: roomType.code,
        name: roomType.name,
        capacity,
        used,
        remaining: Math.max(0, capacity - used),
      };
    });
    const capacity = roomTypes.reduce(
      (total, roomType) => total + roomType.capacity,
      0,
    );
    const used = roomTypes.reduce(
      (total, roomType) => total + roomType.used,
      0,
    );

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
  const dates = getDateRange(
    reservation.arrivalDate,
    reservation.departureDate,
  );
  if (dates.length === 0) return "Select a valid arrival and departure date.";

  for (const date of dates) {
    const day = availability.find((item) => item.date === date);
    const roomType = day?.roomTypes.find(
      (item) => item.code === reservation.roomType,
    );
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
  const [availabilityModalMessage, setAvailabilityModalMessage] = useState("");
  const [showSubmitConfirmModal, setShowSubmitConfirmModal] = useState(false);
  const [showChangeRequestConfirmModal, setShowChangeRequestConfirmModal] =
    useState(false);
  const [reservationToDelete, setReservationToDelete] = useState(null);
  const [editingReservationId, setEditingReservationId] = useState("");
  const [error, setError] = useState("");
  const [reservationSearch, setReservationSearch] = useState("");
  const [reservationSort, setReservationSort] = useState({
    key: "guest",
    direction: "asc",
  });

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

  const activeRequest = (roomingList?.changeRequests || []).find((request) =>
    ["Draft", "Pending Approval"].includes(request.status),
  );
  const isEditable =
    roomingList?.status !== "Submitted" || activeRequest?.status === "Draft";
  const reservations = Array.isArray(activeRequest?.reservations)
    ? activeRequest.reservations
    : Array.isArray(roomingList?.reservations)
      ? roomingList.reservations
      : [];
  const visibleReservations = useMemo(() => {
    const normalizedSearch = reservationSearch.trim().toLocaleLowerCase();
    const filtered = normalizedSearch
      ? reservations.filter((reservation) =>
          `${reservation.firstName || ""} ${reservation.lastName || ""}`
            .toLocaleLowerCase()
            .includes(normalizedSearch),
        )
      : reservations;
    const getSortValue = (reservation) =>
      reservationSort.key === "guest"
        ? `${reservation.lastName || ""} ${reservation.firstName || ""}`
        : (reservation[reservationSort.key] ?? "");

    return [...filtered].sort((left, right) => {
      const leftValue = getSortValue(left);
      const rightValue = getSortValue(right);
      const comparison =
        typeof leftValue === "number" && typeof rightValue === "number"
          ? leftValue - rightValue
          : String(leftValue).localeCompare(String(rightValue), undefined, {
              numeric: true,
              sensitivity: "base",
            });
      return reservationSort.direction === "asc" ? comparison : -comparison;
    });
  }, [reservationSearch, reservationSort, reservations]);
  const availability = useMemo(
    () => buildAvailability(roomingList, reservations),
    [roomingList, reservations],
  );
  const roomTypes = useMemo(() => {
    const unique = new Map();
    const publicRoomTypes = Array.isArray(roomingList?.roomTypes)
      ? roomingList.roomTypes
      : [];
    publicRoomTypes.forEach((roomType) => {
      if (roomType.code)
        unique.set(roomType.code, `${roomType.code} - ${roomType.name}`);
    });

    const roomTypeDays =
      Array.isArray(roomingList?.roomTypeDays) &&
      roomingList.roomTypeDays.length > 0
        ? roomingList.roomTypeDays
        : roomingList?.group?.roomTypeDays || [];

    roomTypeDays.forEach((day) => {
      (day.roomTypes || []).forEach((roomType) => {
        if (roomType.code)
          unique.set(roomType.code, `${roomType.code} - ${roomType.name}`);
      });
    });
    return Array.from(unique, ([code, label]) => ({ code, label }));
  }, [
    roomingList?.group?.roomTypeDays,
    roomingList?.roomTypeDays,
    roomingList?.roomTypes,
  ]);
  const filledRoomNights = availability.reduce(
    (total, day) => total + day.used,
    0,
  );
  const totalRoomNights = availability.reduce(
    (total, day) => total + day.capacity,
    0,
  );

  const updateForm = (field, value) =>
    setForm((current) => ({ ...current, [field]: value }));

  const toggleReservationSort = (key) => {
    setReservationSort((current) => ({
      key,
      direction:
        current.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  };

  const SortableHeader = ({ column, children }) => {
    const active = reservationSort.key === column;
    const SortIcon = active
      ? reservationSort.direction === "asc"
        ? ArrowUp
        : ArrowDown
      : ArrowUpDown;
    return (
      <th
        className="px-3 py-2"
        aria-sort={
          active
            ? reservationSort.direction === "asc"
              ? "ascending"
              : "descending"
            : "none"
        }
      >
        <button
          type="button"
          onClick={() => toggleReservationSort(column)}
          className="inline-flex items-center gap-1.5 hover:text-gray-800"
        >
          {children}
          <SortIcon className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </th>
    );
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (saving) return;

    if (!isEditable) {
      setError("The current official rooming list is read-only.");
      return;
    }

    const availabilityConflict = findAvailabilityConflict(availability, form);
    if (availabilityConflict) {
      setAvailabilityModalMessage(availabilityConflict);
      return;
    }

    setSaving(true);
    setError("");
    try {
      const reservation = editingReservationId
        ? await updateRoomingListReservation(token, editingReservationId, form)
        : await addRoomingListReservation(token, form);
      setRoomingList((current) => ({
        ...current,
        status: current.status === "Submitted" ? "Submitted" : "Concept",
        changeRequests: activeRequest
          ? current.changeRequests.map((request) =>
              request.id === activeRequest.id
                ? {
                    ...request,
                    reservations: editingReservationId
                      ? request.reservations.map((item) =>
                          item.id === editingReservationId ? reservation : item,
                        )
                      : [...request.reservations, reservation],
                  }
                : request,
            )
          : current.changeRequests,
        reservations: editingReservationId
          ? (current?.reservations || []).map((item) =>
              item.id === editingReservationId ? reservation : item,
            )
          : [...(current?.reservations || []), reservation],
      }));
      setForm(emptyReservation);
      if (editingReservationId) setIsReservationFormOpen(false);
      setEditingReservationId("");
      setShowSubmitConfirmModal(false);
    } catch (err) {
      const message = err?.message || "Unable to add reservation.";
      if (message.toLowerCase().includes("available")) {
        setAvailabilityModalMessage(message);
      } else {
        setError(message);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleEditReservation = (reservation) => {
    if (!isEditable) return;
    setEditingReservationId(reservation.id);
    setForm({
      firstName: reservation.firstName || "",
      lastName: reservation.lastName || "",
      arrivalDate: reservation.arrivalDate || "",
      departureDate: reservation.departureDate || "",
      roomType: reservation.roomType || "",
      numberOfAdults: reservation.numberOfAdults ?? 1,
      numberOfChildren: reservation.numberOfChildren ?? 0,
      comment: reservation.comment || "",
    });
    setIsReservationFormOpen(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const cancelEditReservation = () => {
    setEditingReservationId("");
    setForm(emptyReservation);
    setIsReservationFormOpen(false);
  };

  const handleDeleteReservation = async () => {
    if (!reservationToDelete) return;

    try {
      await deleteRoomingListReservation(token, reservationToDelete.id);
      setRoomingList((current) => ({
        ...current,
        status: current.status === "Submitted" ? "Submitted" : "Concept",
        changeRequests: activeRequest
          ? current.changeRequests.map((request) =>
              request.id === activeRequest.id
                ? {
                    ...request,
                    reservations: request.reservations.filter(
                      (item) => item.id !== reservationToDelete.id,
                    ),
                  }
                : request,
            )
          : current.changeRequests,
        reservations: (current?.reservations || []).filter(
          (item) => item.id !== reservationToDelete.id,
        ),
      }));
      if (editingReservationId === reservationToDelete.id)
        cancelEditReservation();
      setReservationToDelete(null);
    } catch (err) {
      setError(err?.message || "Unable to delete reservation.");
    }
  };

  const reload = async () => setRoomingList(await getRoomingListByToken(token));

  const handleMakeChangeRequest = async () => {
    setSaving(true);
    setError("");
    try {
      await createRoomingListChangeRequest(token);
      await reload();
    } catch (err) {
      setError(err?.message || "Unable to create change request.");
    } finally {
      setSaving(false);
    }
  };

  const handleChangeRequestAction = async (action) => {
    setSubmittingRoomingList(true);
    setError("");
    try {
      if (action === "send") await submitRoomingListChangeRequest(token);
      else await cancelRoomingListChangeRequest(token);
      await reload();
      setIsReservationFormOpen(false);
    } catch (err) {
      setError(err?.message || "Unable to update change request.");
    } finally {
      setSubmittingRoomingList(false);
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
      setShowSubmitConfirmModal(false);
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
              <h1 className="text-3xl font-semibold">
                {roomingList?.groupName ||
                  roomingList?.group?.groupName ||
                  "Rooming List"}
              </h1>
              <p className="mt-4 inline-flex rounded-full bg-white/15 px-4 py-2 text-lg font-semibold text-white">
                Status: {roomingList?.status || "Not Started"}
              </p>
              {roomingList?.status === "Submitted" && (
                <div className="mt-3 space-y-1 text-sm text-red-50">
                  <p>
                    Current Official Version: Version{" "}
                    {roomingList.currentVersionNumber || 1}
                  </p>
                  {activeRequest && (
                    <>
                      <p>Change Request: Request {activeRequest.number}</p>
                      <p>Change Request Status: {activeRequest.status}</p>
                    </>
                  )}
                </div>
              )}
            </div>
            {roomingList &&
              (roomingList.status === "Submitted" ? (
                !activeRequest ? (
                  <button
                    type="button"
                    onClick={handleMakeChangeRequest}
                    disabled={saving}
                    className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-[#b41f1f] shadow hover:bg-red-50 disabled:opacity-60"
                  >
                    <Pencil className="h-4 w-4" /> Make Change Request
                  </button>
                ) : activeRequest.status === "Draft" ? (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => handleChangeRequestAction("cancel")}
                      className="rounded-lg border border-white/40 px-4 py-2 text-sm font-semibold"
                    >
                      Cancel Request
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowChangeRequestConfirmModal(true)}
                      className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-[#b41f1f]"
                    >
                      <Send className="h-4 w-4" /> Send Change Request
                    </button>
                  </div>
                ) : null
              ) : (
                <button
                  type="button"
                  onClick={() => setShowSubmitConfirmModal(true)}
                  disabled={
                    submittingRoomingList || roomingList.status === "Submitted"
                  }
                  className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-[#b41f1f] shadow hover:bg-red-50 disabled:cursor-not-allowed disabled:bg-white/40 disabled:text-white/70"
                >
                  <Send className="h-4 w-4" />{" "}
                  {submittingRoomingList
                    ? "Submitting..."
                    : roomingList.status === "Submitted"
                      ? "Submitted"
                      : "Submit Rooming List"}
                </button>
              ))}
          </div>
        </Card>

        {loading ? (
          <p className="text-gray-600">Loading rooming list...</p>
        ) : error ? (
          <p className="text-sm font-semibold text-red-600">{error}</p>
        ) : null}

        {roomingList && (
          <>
            {activeRequest?.status === "Pending Approval" && (
              <Card className="border border-amber-200 bg-amber-50 text-amber-900">
                <p className="font-semibold">
                  Your change request has been submitted and is awaiting
                  approval from the hotel.
                </p>
                <p className="mt-1 text-sm">
                  The current official rooming list remains unchanged until the
                  request has been approved.
                </p>
              </Card>
            )}
            <Card className="border border-gray-100 bg-white/95 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">Overview</h2>
                  <p className="mt-1 text-sm text-gray-600">
                    {filledRoomNights} of {totalRoomNights} room nights have
                    been filled in.
                  </p>
                </div>
              </div>
              <div className="mt-4 overflow-x-auto pb-2">
                <div className="grid auto-cols-[minmax(12rem,1fr)] grid-flow-col gap-3">
                  {availability.map((day) => (
                    <div
                      key={day.date}
                      className="rounded-xl border border-gray-200 bg-gray-50 p-4"
                    >
                      <p className="text-sm font-semibold text-gray-900">
                        {formatDate(day.date)}
                      </p>
                      <p className="mt-2 text-xs text-gray-500">
                        Filled: {day.used}
                      </p>
                      <p className="text-xs text-gray-500">
                        Available: {day.remaining}
                      </p>
                      <p className="text-xs text-gray-500">
                        Total: {day.capacity}
                      </p>
                      <div className="mt-3 space-y-2">
                        {day.roomTypes.map((roomType) => (
                          <div
                            key={`${day.date}-${roomType.code}`}
                            className="rounded-lg bg-white px-2 py-1.5 text-xs shadow-sm"
                          >
                            <p className="font-semibold text-gray-800">
                              {roomType.code} - {roomType.name}
                            </p>
                            <p className="text-gray-500">
                              {roomType.used} filled / {roomType.remaining}{" "}
                              available
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>

            <Card className="overflow-hidden border border-gray-100 bg-white/95 p-0 shadow-sm">
              <div className="flex w-full items-center justify-between gap-4 px-5 py-4">
                <div>
                  <h2 className="text-lg font-semibold">
                    {editingReservationId
                      ? "Edit Reservation"
                      : "Add Reservation"}
                  </h2>
                  <p className="mt-1 text-sm text-gray-600">
                    {editingReservationId
                      ? "Update the selected reservation details."
                      : !isEditable
                        ? "The official rooming list and submitted requests are read-only."
                        : "Open the form to add another reservation to this rooming list."}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setIsReservationFormOpen((current) => !current)
                  }
                  disabled={!isEditable}
                  className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white shadow hover:bg-[#961919] disabled:cursor-not-allowed disabled:bg-gray-300"
                >
                  <Plus className="h-4 w-4" />
                  {isReservationFormOpen ? "Close" : "Add Reservation"}
                </button>
              </div>

              {isReservationFormOpen && isEditable && (
                <form
                  onSubmit={handleSubmit}
                  className="border-t border-gray-100 bg-gradient-to-b from-white to-gray-50 px-5 py-5"
                >
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <Field
                      label="First Name"
                      value={form.firstName}
                      onChange={(value) => updateForm("firstName", value)}
                      required
                    />
                    <Field
                      label="Last Name"
                      value={form.lastName}
                      onChange={(value) => updateForm("lastName", value)}
                      required
                    />
                    <Field
                      label="Arrival Date"
                      type="date"
                      value={form.arrivalDate}
                      min={
                        roomingList.arrival ||
                        roomingList.group?.arrival ||
                        undefined
                      }
                      max={
                        roomingList.departure ||
                        roomingList.group?.departure ||
                        undefined
                      }
                      onChange={(value) => updateForm("arrivalDate", value)}
                      required
                    />
                    <Field
                      label="Departure Date"
                      type="date"
                      value={form.departureDate}
                      min={
                        form.arrivalDate ||
                        roomingList.arrival ||
                        roomingList.group?.arrival ||
                        undefined
                      }
                      max={
                        roomingList.departure ||
                        roomingList.group?.departure ||
                        undefined
                      }
                      onChange={(value) => updateForm("departureDate", value)}
                      required
                    />
                    <div className="pt-6">
                      <select
                        value={form.roomType}
                        onChange={(event) =>
                          updateForm("roomType", event.target.value)
                        }
                        className="w-44 max-w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
                        aria-label="Room Type"
                        required
                      >
                        <option value="">Select Room Type</option>
                        {roomTypes.map((roomType) => (
                          <option key={roomType.code} value={roomType.code}>
                            {roomType.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <Field
                      label="Number of Adults"
                      type="number"
                      min="0"
                      value={form.numberOfAdults}
                      onChange={(value) => updateForm("numberOfAdults", value)}
                      required
                    />
                    <Field
                      label="Number of Children"
                      type="number"
                      min="0"
                      value={form.numberOfChildren}
                      onChange={(value) =>
                        updateForm("numberOfChildren", value)
                      }
                      required
                    />
                    <label className="block text-sm font-medium text-gray-700 lg:col-span-2">
                      Comment
                      <textarea
                        value={form.comment}
                        onChange={(event) =>
                          updateForm("comment", event.target.value)
                        }
                        className="mt-1 min-h-[4.5rem] w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
                      />
                    </label>
                  </div>
                  <div className="mt-5 flex justify-end gap-3">
                    {editingReservationId && (
                      <button
                        type="button"
                        onClick={cancelEditReservation}
                        className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-100"
                      >
                        <X className="h-4 w-4" /> Cancel Edit
                      </button>
                    )}
                    <button
                      type="submit"
                      disabled={saving}
                      className="inline-flex items-center gap-2 rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white shadow hover:bg-[#961919] disabled:cursor-not-allowed disabled:bg-gray-300"
                    >
                      <Plus className="h-4 w-4" />{" "}
                      {saving
                        ? editingReservationId
                          ? "Saving..."
                          : "Adding..."
                        : editingReservationId
                          ? "Save Reservation"
                          : "Add Reservation"}
                    </button>
                  </div>
                </form>
              )}
            </Card>

            <Card className="border border-gray-100 bg-white/95 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold">Reservations</h2>
                  <p className="mt-1 text-sm text-gray-600">
                    Search by guest name or sort the list by any column.
                  </p>
                </div>
                <label className="relative block w-full sm:w-72">
                  <span className="sr-only">
                    Search reservations by guest name
                  </span>
                  <Search
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
                    aria-hidden="true"
                  />
                  <input
                    type="search"
                    value={reservationSearch}
                    onChange={(event) =>
                      setReservationSearch(event.target.value)
                    }
                    placeholder="Search by guest name..."
                    className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
                  />
                </label>
              </div>
              <div className="mt-4 overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 text-sm">
                  <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                    <tr>
                      <SortableHeader column="guest">Guest</SortableHeader>
                      <SortableHeader column="arrivalDate">
                        Arrival
                      </SortableHeader>
                      <SortableHeader column="departureDate">
                        Departure
                      </SortableHeader>
                      <SortableHeader column="roomType">
                        Room Type
                      </SortableHeader>
                      <SortableHeader column="numberOfAdults">
                        Adults
                      </SortableHeader>
                      <SortableHeader column="numberOfChildren">
                        Children
                      </SortableHeader>
                      <SortableHeader column="comment">Comment</SortableHeader>
                      <th className="px-3 py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 bg-white">
                    {visibleReservations.length === 0 ? (
                      <tr>
                        <td className="px-3 py-4 text-gray-500" colSpan="8">
                          {reservations.length === 0
                            ? "No reservations have been added yet."
                            : "No reservations match your search."}
                        </td>
                      </tr>
                    ) : (
                      visibleReservations.map((reservation) => (
                        <tr key={reservation.id}>
                          <td className="px-3 py-2 font-medium text-gray-900">
                            {reservation.firstName} {reservation.lastName}
                          </td>
                          <td className="px-3 py-2 text-gray-700">
                            {reservation.arrivalDate}
                          </td>
                          <td className="px-3 py-2 text-gray-700">
                            {reservation.departureDate}
                          </td>
                          <td className="px-3 py-2 text-gray-700">
                            {reservation.roomType}
                          </td>
                          <td className="px-3 py-2 text-gray-700">
                            {reservation.numberOfAdults}
                          </td>
                          <td className="px-3 py-2 text-gray-700">
                            {reservation.numberOfChildren}
                          </td>
                          <td className="px-3 py-2 text-gray-700">
                            {reservation.comment || "—"}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <div className="inline-flex gap-2">
                              {isEditable && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleEditReservation(reservation)
                                    }
                                    className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-[#b41f1f]"
                                    aria-label={`Edit reservation for ${reservation.firstName} ${reservation.lastName}`}
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setReservationToDelete(reservation)
                                    }
                                    className="rounded-lg p-2 text-gray-500 hover:bg-red-50 hover:text-[#b41f1f]"
                                    aria-label={`Delete reservation for ${reservation.firstName} ${reservation.lastName}`}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}

        <MessageModal
          open={Boolean(availabilityModalMessage)}
          title="Room type unavailable"
          message={availabilityModalMessage}
          confirmLabel="OK"
          onConfirm={() => setAvailabilityModalMessage("")}
        />

        <MessageModal
          open={Boolean(reservationToDelete)}
          title="Delete Reservation"
          message={
            reservationToDelete
              ? `Delete reservation for ${reservationToDelete.firstName} ${reservationToDelete.lastName}? This cannot be undone.`
              : ""
          }
          confirmLabel="Delete Reservation"
          cancelLabel="Cancel"
          onCancel={() => setReservationToDelete(null)}
          onConfirm={handleDeleteReservation}
          danger
        />

        <MessageModal
          open={showChangeRequestConfirmModal}
          title="Send Change Request"
          message="Are you sure you want to send this change request to the hotel? You will no longer be able to edit it while it is awaiting approval."
          confirmLabel="Send Change Request"
          cancelLabel="Cancel"
          onCancel={() => setShowChangeRequestConfirmModal(false)}
          onConfirm={() => {
            setShowChangeRequestConfirmModal(false);
            handleChangeRequestAction("send");
          }}
        />

        <MessageModal
          open={showSubmitConfirmModal}
          title="Submit Rooming List"
          message="Are you sure you want to submit this rooming list? After submission, it becomes the official rooming list. Any further additions, edits, or deletions must be made through a new change request."
          confirmLabel={
            submittingRoomingList ? "Submitting..." : "Submit Rooming List"
          }
          cancelLabel="Cancel"
          onCancel={() => setShowSubmitConfirmModal(false)}
          onConfirm={handleSubmitRoomingList}
          danger
        />
      </PageContainer>
    </div>
  );
}

function MessageModal({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  danger = false,
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onCancel || onConfirm}
        aria-hidden="true"
      />
      <div className="relative z-[80] w-full max-w-md rounded-2xl bg-white p-6 text-center shadow-xl">
        <h2 className="text-xl font-semibold text-gray-900">{title}</h2>
        <p className="mt-3 text-sm leading-6 text-gray-600">{message}</p>
        <div className="mt-6 flex justify-center gap-3">
          {cancelLabel && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-200"
            >
              {cancelLabel}
            </button>
          )}
          <button
            type="button"
            onClick={onConfirm}
            className={`rounded-lg px-4 py-2 text-sm font-semibold text-white ${danger ? "bg-[#b41f1f] hover:bg-[#961919]" : "bg-gray-900 hover:bg-gray-800"}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
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
