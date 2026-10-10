import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  BedDouble,
  CalendarDays,
  ChevronDown,
  Copy,
  Link,
  Mail,
  Pencil,
  Phone,
  Trash2,
  UserRound,
} from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { usePermission } from "../../hooks/usePermission";
import { deleteGroup, getGroup } from "../../services/firebaseGroups";
import {
  createRoomingListForGroup,
  getRoomingListByToken,
  setRoomingListPublicAccess,
} from "../../services/firebaseRoomingLists";
import { getNotificationLists } from "../../services/firebaseNotificationLists";
import NotificationListSelector from "./NotificationListSelector";
import { normalizeNotificationSelections } from "../../constants/groupNotifications";
import {
  calculateRoomingListDeadline,
  getRoomingListDeadlineDays,
} from "../../utils/groupDeadline";

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
      <div className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
        {Icon && <Icon className="h-4 w-4 text-brand-800" />}
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
  const canCreateRoomingLists = usePermission("roominglists", "create");
  const [accessExpiry, setAccessExpiry] = useState("");
  const [savingAccess, setSavingAccess] = useState(false);
  const canUpdateRoomingLists = usePermission("roominglists", "update");
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
    [],
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
          const list = await getRoomingListByToken(result.roomingListToken, { internal: true });
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

  const roomTypeDays = Array.isArray(group?.roomTypeDays)
    ? group.roomTypeDays
    : [];

  const reservations = Array.isArray(roomingList?.reservations)
    ? roomingList.reservations
    : [];
  const pendingChangeRequest = (roomingList?.changeRequests || []).find(
    (request) => request.status === "Pending Approval",
  );
  const pickedUpRooms = reservations.reduce(
    (total, reservation) =>
      total +
      getDateRange(reservation.arrivalDate, reservation.departureDate).length,
    0,
  );

  const getPickedUpRoomsForDayAndType = (date, roomTypeCode) =>
    reservations.filter((reservation) => {
      if (reservation.roomType !== roomTypeCode) return false;
      if (!reservation.arrivalDate || !reservation.departureDate) return false;
      return (
        reservation.arrivalDate <= date && date < reservation.departureDate
      );
    }).length;

  const handleCreateRoomingList = async () => {
    if (!canCreateRoomingLists || !hotelUid || !group || creatingRoomingList) return;

    setCreatingRoomingList(true);
    setError("");
    try {
      const result = await createRoomingListForGroup(
        hotelUid,
        group,
        auth.currentUser?.uid || "unknown",
      );
      setGroup((current) => ({
        ...current,
        roomingListToken: result.token,
        roomingListLink: result.link,
        roomingListStatus: current?.roomingListStatus || "Not Started",
      }));
      setRoomingList(await getRoomingListByToken(result.token, { internal: true }));
    } catch (err) {
      console.error("Unable to create rooming list:", err);
      setError(err?.message || "Unable to create rooming list.");
    } finally {
      setCreatingRoomingList(false);
    }
  };

  const changePublicAccess = async (enabled) => {
    setSavingAccess(true); setError("");
    try {
      const expiresAt = accessExpiry ? Date.parse(accessExpiry + "T23:59:59Z") : Date.now() + 30 * 86400000;
      await setRoomingListPublicAccess(group.roomingListToken, enabled, expiresAt);
      setRoomingList(await getRoomingListByToken(group.roomingListToken, { internal: true }));
    } catch (error) { setError(error.message || "Unable to change organizer access."); }
    finally { setSavingAccess(false); }
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
    <div className="min-h-screen bg-canvas text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6 pb-10">
        <Card className="border-0 bg-gradient-to-r from-brand-800 via-brand-900 to-brand-950 text-white shadow-lg">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <p className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-brand-100">
                <BedDouble className="h-3.5 w-3.5" /> M&amp;E block management
              </p>
              <h1 className="text-3xl font-semibold">
                {group?.groupName || "Group Details"}
              </h1>
              <p className="max-w-2xl text-sm text-brand-100">
                View group block details, organiser contacts, and daily room
                type allowances.
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
                className="inline-flex items-center justify-center rounded-lg border border-white/30 bg-white px-3 py-2 text-brand-800 shadow hover:bg-brand-50 disabled:cursor-not-allowed disabled:bg-white/40 disabled:text-white/70"
                aria-label="Edit group"
              >
                <Pencil className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setShowDeleteModal(true)}
                disabled={!canDeleteGroups || !group || deletingGroup}
                className="inline-flex items-center justify-center rounded-lg border border-white/30 bg-white px-3 py-2 text-red-700 shadow hover:bg-red-50 disabled:cursor-not-allowed disabled:bg-white/40 disabled:text-white/70"
                aria-label="Delete group"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        </Card>

        {loading ? (
          <p className="text-gray-600">Loading group...</p>
        ) : error ? (
          <p className="text-sm font-semibold text-red-600">{error}</p>
        ) : null}

        {group && (
          <>
            <div className="grid gap-4 xl:grid-cols-3">
              <Card className="border border-gray-100 bg-white/95 shadow-sm xl:col-span-2">
                <h2 className="text-lg font-semibold">Block Details</h2>
                <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  <DetailItem
                    icon={CalendarDays}
                    label="Arrival"
                    value={formatDate(group.arrival)}
                  />
                  <DetailItem
                    icon={CalendarDays}
                    label="Departure"
                    value={formatDate(group.departure)}
                  />
                  <DetailItem
                    icon={CalendarDays}
                    label="Rooming List Deadline"
                    value={formatDate(
                      calculateRoomingListDeadline(
                        group.arrival,
                        getRoomingListDeadlineDays(group),
                      ),
                    )}
                  />
                  <DetailItem label="Block Code" value={group.blockCode} />
                  <DetailItem
                    icon={BedDouble}
                    label="Blocked Rooms"
                    value={group.blockedRooms ?? 0}
                  />
                  <DetailItem
                    icon={BedDouble}
                    label="Picked Up Rooms"
                    value={pickedUpRooms}
                  />
                </div>
              </Card>
              <Card className="border border-gray-100 bg-white/95 shadow-sm">
                <h2 className="text-lg font-semibold">Contacts</h2>
                <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
                  <DetailItem
                    icon={UserRound}
                    label="Block Owner"
                    value={group.meOfficer}
                  />
                  <DetailItem
                    icon={UserRound}
                    label="Organiser Contact Person"
                    value={group.organiserName}
                  />
                  <DetailItem
                    icon={Mail}
                    label="Organiser Email"
                    value={group.organiserEmail}
                  />
                  <DetailItem
                    icon={Phone}
                    label="Organiser Phone"
                    value={group.organiserPhone}
                  />
                </div>
              </Card>
            </div>

            <Card className="border border-gray-100 bg-white/95 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">
                    Daily Room Type Allowances
                  </h2>
                  <p className="mt-1 text-sm text-gray-600">
                    Scroll horizontally to review availability per day.
                  </p>
                </div>
                <span className="rounded-full bg-brand-50 px-3 py-1 text-sm font-semibold text-brand-800">
                  Rooming List Status:{" "}
                  {group.roomingListStatus || "Not Started"}
                </span>
              </div>
              <div className="mt-4 overflow-x-auto pb-2">
                {roomTypeDays.length === 0 ? (
                  <p className="text-sm text-gray-600">
                    No room type allowances have been added.
                  </p>
                ) : (
                  <div className="grid auto-cols-[minmax(15rem,1fr)] grid-flow-col gap-4">
                    {roomTypeDays.map((day) => (
                      <div
                        key={day.date}
                        className="rounded-xl border border-gray-200 bg-gray-50/60 p-4"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <h3 className="font-semibold text-gray-900">
                              {formatDate(day.date)}
                            </h3>
                            <p className="text-xs text-gray-500">{day.date}</p>
                          </div>
                          <span className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-800">
                            {(day.roomTypes || []).reduce(
                              (total, roomType) =>
                                total + Number(roomType.quantity || 0),
                              0,
                            )}{" "}
                            rooms
                          </span>
                        </div>
                        <div className="mt-3 space-y-2">
                          {(day.roomTypes || []).map((roomType, index) => (
                            <div
                              key={`${day.date}-${roomType.code || index}`}
                              className="rounded-lg bg-white px-3 py-2 text-sm shadow-sm"
                            >
                              <p className="font-semibold text-gray-900">
                                {roomType.code} - {roomType.name}
                              </p>
                              <p className="text-gray-600">
                                Quantity: {roomType.quantity || 0}
                              </p>
                              <p className="text-xs font-semibold text-brand-800">
                                Picked up:{" "}
                                {getPickedUpRoomsForDayAndType(
                                  day.date,
                                  roomType.code,
                                )}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>

            {roomingList && canUpdateRoomingLists && (
              <Card className="border border-gray-200 bg-white shadow-sm">
                <h2 className="font-semibold text-gray-900">Organizer link access</h2>
                <p className="mt-1 text-sm text-gray-600">Anyone with this link can view and edit this group's guest list until expiry. Share it only with the organizer.</p>
                <p className="mt-2 text-sm">{roomingList.publicAccessEnabled ? "Enabled" : "Disabled"} · Expires: {roomingList.publicAccessExpiresAtMillis ? new Date(roomingList.publicAccessExpiresAtMillis).toLocaleString() : "Not set"}</p>
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <label className="text-sm">New expiry date (UTC)<input type="date" value={accessExpiry} onChange={(event) => setAccessExpiry(event.target.value)} className="mt-1 block rounded-lg border border-gray-300 p-2" /></label>
                  <button disabled={savingAccess} onClick={() => changePublicAccess(true)} className="rounded-lg bg-brand-800 px-4 py-2 text-sm font-semibold text-white">{savingAccess ? "Saving..." : "Enable or extend link"}</button>
                  <button disabled={savingAccess || !roomingList.publicAccessEnabled} onClick={() => changePublicAccess(false)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm">Disable link</button>
                </div>
              </Card>
            )}

            {pendingChangeRequest && (
              <Card className="border border-amber-300 bg-amber-50 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="font-semibold text-amber-950">
                      Rooming List Change Request Pending
                    </h2>
                    <p className="mt-1 text-sm text-amber-800">
                      Request {pendingChangeRequest.number}, based on Version{" "}
                      {pendingChangeRequest.baseVersionNumber}, is awaiting
                      review.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      navigate(
                        `/me/groups/${groupId}/rooming-list-change-request/${group.roomingListToken}`,
                      )
                    }
                    className="rounded-lg bg-brand-800 px-4 py-2 text-sm font-semibold text-white"
                  >
                    Review Change Request
                  </button>
                </div>
              </Card>
            )}

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
                  <p className="mt-1 text-sm text-gray-600">
                    Notification Lists added to this Group.
                  </p>
                </div>
                <ChevronDown
                  className={`h-5 w-5 shrink-0 text-gray-500 transition-transform ${notificationsOpen ? "rotate-180" : ""}`}
                />
              </button>
              {notificationsOpen && (
                <div
                  id="group-notifications-content"
                  className="mt-5 border-t border-gray-100 pt-5"
                >
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
                  <p className="mt-1 text-sm text-gray-600">
                    Create a secure public link that can be opened without
                    signing in.
                  </p>
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
                  {copyMessage && (
                    <p className="mt-2 text-sm font-semibold text-green-700">
                      {copyMessage}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={handleCreateRoomingList}
                  disabled={
                    !canCreateRoomingLists || creatingRoomingList || Boolean(group.roomingListLink)
                  }
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand-800 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-brand-950 disabled:cursor-not-allowed disabled:bg-gray-300"
                >
                  <Link className="h-4 w-4" />
                  {group.roomingListLink
                    ? "Rooming List Created"
                    : creatingRoomingList
                      ? "Creating..."
                      : "Create Rooming List & Link"}
                </button>
              </div>
            </Card>
          </>
        )}

        {showDeleteModal && (
          <div
            className="fixed inset-0 z-[70] flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-group-title"
          >
            <button
              type="button"
              className="absolute inset-0 bg-black/50 backdrop-blur-sm"
              onClick={() => !deletingGroup && setShowDeleteModal(false)}
              aria-label="Close delete group confirmation"
            />
            <div className="relative z-[80] w-full max-w-md rounded-2xl bg-white p-6 text-center shadow-xl">
              <h2
                id="delete-group-title"
                className="text-xl font-semibold text-gray-900"
              >
                Delete Group
              </h2>
              <p className="mt-3 text-sm leading-6 text-gray-600">
                Are you sure you want to delete{" "}
                {group?.groupName || "this group"}? This action cannot be
                undone.
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
                  className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-gray-300"
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
