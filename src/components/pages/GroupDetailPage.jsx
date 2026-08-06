import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, BedDouble, CalendarDays, ChevronDown, Copy, Link, Mail, Pencil, Phone, Trash2, UserRound } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { usePermission } from "../../hooks/usePermission";
import { deleteGroup, getGroup } from "../../services/firebaseGroups";
import { createRoomingListForGroup, getRoomingListByToken } from "../../services/firebaseRoomingLists";
import { getNotificationLists } from "../../services/firebaseNotificationLists";
import NotificationListSelector from "./NotificationListSelector";
import { normalizeNotificationSelections } from "../../constants/groupNotifications";

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
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(`${value}T00:00:00`));
}

function DetailItem({ icon: Icon, label, value }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
        {Icon && <Icon className="h-4 w-4 text-[#b41f1f]" />}
        {label}
      </div>
      <p className="mt-2 text-sm font-semibold text-gray-900">{value || "—"}</p>
    </div>
  );
}

export default function GroupDetailPage() {
  const navigate = useNavigate();
  const { groupId } = useParams();
  const { hotelUid } = useHotelContext();
  const canEditGroups = usePermission("groups", "update");
  const canDeleteGroups = usePermission("groups", "delete");
  const [group, setGroup] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creatingRoomingList, setCreatingRoomingList] = useState(false);
  const [copyMessage, setCopyMessage] = useState("");
  const [roomingList, setRoomingList] = useState(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletingGroup, setDeletingGroup] = useState(false);
  const [notificationLists, setNotificationLists] = useState([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);

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

    async function loadGroup() {
      if (!hotelUid || !groupId) return;
      setLoading(true);
      setError("");
      try {
        const [result, lists] = await Promise.all([
          getGroup(hotelUid, groupId),
          getNotificationLists(hotelUid),
        ]);
        if (!active) return;
        setGroup(result);
        setNotificationLists(lists);
        if (result?.roomingListToken) {
          const list = await getRoomingListByToken(result.roomingListToken);
          if (active) setRoomingList(list);
        } else if (active) {
          setRoomingList(null);
        }
        if (!result) setError("Group not found.");
      } catch (err) {
        console.error("Unable to load group:", err);
        if (active) setError(err?.message || "Unable to load group.");
      } finally {
        if (active) setLoading(false);
      }
    }

    loadGroup();
    return () => {
      active = false;
    };
  }, [groupId, hotelUid]);

  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  const roomTypeDays = Array.isArray(group?.roomTypeDays) ? group.roomTypeDays : [];

  const reservations = Array.isArray(roomingList?.reservations) ? roomingList.reservations : [];
  const pendingChangeRequest = (roomingList?.changeRequests || []).find((request) => request.status === "Pending Approval");
  const pickedUpRooms = reservations.reduce(
    (total, reservation) => total + getDateRange(reservation.arrivalDate, reservation.departureDate).length,
    0
  );

  const getPickedUpRoomsForDayAndType = (date, roomTypeCode) =>
    reservations.filter((reservation) => {
      if (reservation.roomType !== roomTypeCode) return false;
      if (!reservation.arrivalDate || !reservation.departureDate) return false;
      return reservation.arrivalDate <= date && date < reservation.departureDate;
    }).length;

  const handleCreateRoomingList = async () => {
    if (!hotelUid || !group || creatingRoomingList) return;

    setCreatingRoomingList(true);
    setError("");
    try {
      const result = await createRoomingListForGroup(hotelUid, group, auth.currentUser?.uid || "unknown");
      setGroup((current) => ({
        ...current,
        roomingListToken: result.token,
        roomingListLink: result.link,
        roomingListStatus: current?.roomingListStatus || "Not Started",
      }));
      setRoomingList(await getRoomingListByToken(result.token));
    } catch (err) {
      console.error("Unable to create rooming list:", err);
      setError(err?.message || "Unable to create rooming list.");
    } finally {
      setCreatingRoomingList(false);
    }
  };

  const handleCopyRoomingListLink = async () => {
    if (!group?.roomingListLink) return;
    try {
      await navigator.clipboard.writeText(group.roomingListLink);
      setCopyMessage("Copied to clipboard.");
    } catch (err) {
      console.error("Unable to copy rooming list link:", err);
      setCopyMessage("Copy the link manually.");
    }
  };

  const handleDeleteGroup = async () => {
    if (!hotelUid || !groupId || !canDeleteGroups || deletingGroup) return;

    setDeletingGroup(true);
    setError("");
    try {
      await deleteGroup(hotelUid, groupId);
      navigate("/me/groups");
    } catch (err) {
      console.error("Unable to delete group:", err);
      setError(err?.message || "Unable to delete group.");
      setShowDeleteModal(false);
      setDeletingGroup(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-white via-gray-50 to-gray-100 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6 pb-10">
        <Card className="border-0 bg-gradient-to-r from-[#b41f1f] via-[#a71c1c] to-[#7f1717] text-white shadow-lg">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <p className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-red-100">
                <BedDouble className="h-3.5 w-3.5" /> M&amp;E block management
              </p>
              <h1 className="text-3xl font-semibold">{group?.groupName || "Group Details"}</h1>
              <p className="max-w-2xl text-sm text-red-100">
                View group block details, organiser contacts, and daily room type allowances.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => navigate("/me/groups")}
                className="inline-flex items-center gap-2 rounded-lg border border-white/30 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/20"
              >
                <ArrowLeft className="h-4 w-4" /> Back to Groups
              </button>
              <button
                type="button"
                onClick={() => navigate(`/me/groups/${groupId}/edit`)}
                disabled={!canEditGroups || !group}
                className="inline-flex items-center justify-center rounded-lg border border-white/30 bg-white px-3 py-2 text-[#b41f1f] shadow hover:bg-red-50 disabled:cursor-not-allowed disabled:bg-white/40 disabled:text-white/70"
                aria-label="Edit group"
              >
                <Pencil className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setShowDeleteModal(true)}
                disabled={!canDeleteGroups || !group || deletingGroup}
                className="inline-flex items-center justify-center rounded-lg border border-white/30 bg-white px-3 py-2 text-[#b41f1f] shadow hover:bg-red-50 disabled:cursor-not-allowed disabled:bg-white/40 disabled:text-white/70"
                aria-label="Delete group"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        </Card>

        {loading ? <p className="text-gray-600">Loading group...</p> : error ? <p className="text-sm font-semibold text-red-600">{error}</p> : null}

        {group && (
          <>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <DetailItem icon={CalendarDays} label="Arrival" value={formatDate(group.arrival)} />
              <DetailItem icon={CalendarDays} label="Departure" value={formatDate(group.departure)} />
              <DetailItem icon={CalendarDays} label="Rooming List Deadline" value={formatDate(group.roomingListDeadline)} />
              <DetailItem icon={BedDouble} label="Blocked Rooms" value={group.blockedRooms ?? 0} />
              <DetailItem icon={BedDouble} label="Picked Up Rooms" value={pickedUpRooms} />
              <DetailItem label="Block Code" value={group.blockCode} />
              <DetailItem icon={UserRound} label="M&E Officer" value={group.meOfficer} />
              <DetailItem icon={UserRound} label="Organiser" value={group.organiserName} />
              <DetailItem icon={Mail} label="Organiser Email" value={group.organiserEmail} />
              <DetailItem icon={Phone} label="Organiser Phone" value={group.organiserPhone} />
            </div>

            <Card className="border border-gray-100 bg-white/95 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">Daily Room Type Allowances</h2>
                  <p className="mt-1 text-sm text-gray-600">Scroll horizontally to review availability per day.</p>
                </div>
                <span className="rounded-full bg-red-50 px-3 py-1 text-sm font-semibold text-[#b41f1f]">
                  Rooming List Status: {group.roomingListStatus || "Not Started"}
                </span>
              </div>
              <div className="mt-4 overflow-x-auto pb-2">
                {roomTypeDays.length === 0 ? (
                  <p className="text-sm text-gray-600">No room type allowances have been added.</p>
                ) : (
                  <div className="grid auto-cols-[minmax(15rem,1fr)] grid-flow-col gap-4">
                    {roomTypeDays.map((day) => (
                      <div key={day.date} className="rounded-xl border border-gray-200 bg-gray-50/60 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <h3 className="font-semibold text-gray-900">{formatDate(day.date)}</h3>
                            <p className="text-xs text-gray-500">{day.date}</p>
                          </div>
                          <span className="rounded-full bg-red-50 px-2.5 py-1 text-xs font-semibold text-[#b41f1f]">
                            {(day.roomTypes || []).reduce((total, roomType) => total + Number(roomType.quantity || 0), 0)} rooms
                          </span>
                        </div>
                        <div className="mt-3 space-y-2">
                          {(day.roomTypes || []).map((roomType, index) => (
                            <div key={`${day.date}-${roomType.code || index}`} className="rounded-lg bg-white px-3 py-2 text-sm shadow-sm">
                              <p className="font-semibold text-gray-900">{roomType.code} - {roomType.name}</p>
                              <p className="text-gray-600">Quantity: {roomType.quantity || 0}</p>
                              <p className="text-xs font-semibold text-[#b41f1f]">Picked up: {getPickedUpRoomsForDayAndType(day.date, roomType.code)}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>

            {pendingChangeRequest && <Card className="border border-amber-300 bg-amber-50 shadow-sm"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold text-amber-950">Rooming List Change Request Pending</h2><p className="mt-1 text-sm text-amber-800">Request {pendingChangeRequest.number}, based on Version {pendingChangeRequest.baseVersionNumber}, is awaiting review.</p></div><button type="button" onClick={() => navigate(`/me/groups/${groupId}/rooming-list-change-request/${group.roomingListToken}`)} className="rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white">Review Change Request</button></div></Card>}

            <Card className="border border-gray-100 bg-white/95 shadow-sm">
              <button
                type="button"
                onClick={() => setNotificationsOpen((current) => !current)}
                className="flex w-full items-center justify-between gap-4 text-left"
                aria-expanded={notificationsOpen}
                aria-controls="group-notifications-content"
              >
                <div>
                  <h2 className="text-lg font-semibold">Notifications</h2>
                  <p className="mt-1 text-sm text-gray-600">Notification Lists added to this Group.</p>
                </div>
                <ChevronDown className={`h-5 w-5 shrink-0 text-gray-500 transition-transform ${notificationsOpen ? "rotate-180" : ""}`} />
              </button>
              {notificationsOpen && (
                <div id="group-notifications-content" className="mt-5 border-t border-gray-100 pt-5">
                  <NotificationListSelector
                    lists={notificationLists}
                    value={normalizeNotificationSelections(group.notifications)}
                    readOnly
                  />
                </div>
              )}
            </Card>

            <Card className="border border-gray-100 bg-white/95 shadow-sm">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div className="flex-1">
                  <h2 className="text-lg font-semibold">Rooming List Link</h2>
                  <p className="mt-1 text-sm text-gray-600">Create a secure public link that can be opened without signing in.</p>
                  {group.roomingListLink && (
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                      <input
                        value={group.roomingListLink}
                        readOnly
                        className="w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-700"
                      />
                      <button
                        type="button"
                        onClick={handleCopyRoomingListLink}
                        className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-100"
                      >
                        <Copy className="h-4 w-4" /> Copy Link
                      </button>
                    </div>
                  )}
                  {copyMessage && <p className="mt-2 text-sm font-semibold text-green-700">{copyMessage}</p>}
                </div>
                <button
                  type="button"
                  onClick={handleCreateRoomingList}
                  disabled={creatingRoomingList || Boolean(group.roomingListLink)}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white shadow hover:bg-[#961919] disabled:cursor-not-allowed disabled:bg-gray-300"
                >
                  <Link className="h-4 w-4" />
                  {group.roomingListLink ? "Rooming List Created" : creatingRoomingList ? "Creating..." : "Create Rooming List & Link"}
                </button>
              </div>
            </Card>
          </>
        )}

        {showDeleteModal && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="delete-group-title">
            <button
              type="button"
              className="absolute inset-0 bg-black/50 backdrop-blur-sm"
              onClick={() => !deletingGroup && setShowDeleteModal(false)}
              aria-label="Close delete group confirmation"
            />
            <div className="relative z-[80] w-full max-w-md rounded-2xl bg-white p-6 text-center shadow-xl">
              <h2 id="delete-group-title" className="text-xl font-semibold text-gray-900">Delete Group</h2>
              <p className="mt-3 text-sm leading-6 text-gray-600">
                Are you sure you want to delete {group?.groupName || "this group"}? This action cannot be undone.
              </p>
              <div className="mt-6 flex justify-center gap-3">
                <button
                  type="button"
                  onClick={() => setShowDeleteModal(false)}
                  disabled={deletingGroup}
                  className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDeleteGroup}
                  disabled={deletingGroup}
                  className="rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white hover:bg-[#961919] disabled:cursor-not-allowed disabled:bg-gray-300"
                >
                  {deletingGroup ? "Deleting..." : "Delete Group"}
                </button>
              </div>
            </div>
          </div>
        )}
      </PageContainer>
    </div>
  );
}
