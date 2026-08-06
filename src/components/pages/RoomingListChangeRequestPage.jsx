import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Check, X } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import {
  calculateRoomingListChanges,
  calculateRoomTypePickupSummary,
  getRoomingListByToken,
  reviewRoomingListChangeRequest,
} from "../../services/firebaseRoomingLists";

const FIELD_LABELS = {
  firstName: "First Name",
  lastName: "Last Name",
  arrivalDate: "Arrival Date",
  departureDate: "Departure Date",
  roomType: "Room Type",
  numberOfAdults: "Adults",
  numberOfChildren: "Children",
  comment: "Comment",
};
const guestName = (reservation) =>
  `${reservation.firstName || ""} ${reservation.lastName || ""}`.trim() ||
  "Unnamed guest";

export default function RoomingListChangeRequestPage() {
  const { groupId, requestId } = useParams();
  const navigate = useNavigate();
  const [roomingList, setRoomingList] = useState(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDecision, setConfirmDecision] = useState("");

  useEffect(() => {
    getRoomingListByToken(requestId)
      .then(setRoomingList)
      .catch((err) => setError(err.message));
  }, [requestId]);
  const request =
    (roomingList?.changeRequests || []).find(
      (item) => item.status === "Pending Approval",
    ) || (roomingList?.changeRequests || []).at(-1);
  const base =
    (roomingList?.versions || []).find(
      (version) => version.number === request?.baseVersionNumber,
    )?.reservations || [];
  const changes =
    request?.changes ||
    calculateRoomingListChanges(base, request?.reservations || []);
  const addedReservationIds = new Set(
    changes.added.map((reservation) => reservation.id),
  );
  const changedReservationIds = new Set(
    changes.changed.map((reservation) => reservation.id),
  );
  const changedReservationsById = new Map(
    changes.changed.map((change) => [change.id, change]),
  );
  const removedReservationIds = new Set(
    changes.removed.map((reservation) => reservation.id),
  );
  const requestedReservations = [
    ...(request?.reservations || []),
    ...changes.removed,
  ];
  const pickupSummary = calculateRoomTypePickupSummary(
    roomingList?.roomTypeDays || roomingList?.group?.roomTypeDays,
    base,
    request?.reservations || [],
  );

  const review = async (decision) => {
    setSaving(true);
    setError("");
    try {
      await reviewRoomingListChangeRequest(
        requestId,
        request.id,
        decision,
        reason,
      );
      navigate(`/me/groups/${groupId}`);
    } catch (err) {
      setError(err?.message || "Unable to review request.");
      setSaving(false);
    }
  };
  const logout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <HeaderBar onLogout={logout} />
      <PageContainer className="space-y-6 pb-10">
        <button
          onClick={() => navigate(`/me/groups/${groupId}`)}
          className="inline-flex items-center gap-2 text-sm font-semibold text-gray-700"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Group
        </button>
        {error && <p className="font-semibold text-red-600">{error}</p>}
        {roomingList && request && (
          <>
            <Card className="border-0 bg-gradient-to-r from-[#b41f1f] to-[#7f1717] text-white">
              <p className="text-sm text-red-100">
                {roomingList.groupName} · Rooming List
              </p>
              <h1 className="mt-1 text-3xl font-semibold">
                Change Request {request.number}
              </h1>
              <div className="mt-4 grid gap-2 text-sm sm:grid-cols-3">
                <p>
                  Status: <b>{request.status}</b>
                </p>
                <p>
                  Submitted:{" "}
                  <b>
                    {request.submittedAt
                      ? new Date(request.submittedAt).toLocaleString()
                      : "—"}
                  </b>
                </p>
                <p>
                  Based on: <b>Version {request.baseVersionNumber}</b>
                </p>
              </div>
            </Card>
            <Card>
              <h2 className="text-lg font-semibold">Changes</h2>
              <div className="mt-4 grid gap-4 lg:grid-cols-3">
                <ChangeGroup
                  title="Added"
                  tone="green"
                  items={changes.added}
                  render={(item) => guestName(item)}
                />
                <ChangeGroup
                  title="Removed"
                  tone="red"
                  items={changes.removed}
                  render={(item) => guestName(item)}
                />
                <ChangeGroup
                  title="Changed"
                  tone="amber"
                  items={changes.changed}
                  render={(item) => (
                    <div>
                      <b>{guestName(item.after)}</b>
                      {item.fields.map((field) => (
                        <p key={field.field} className="mt-1 text-xs">
                          {FIELD_LABELS[field.field] || field.field}:{" "}
                          <span className="line-through">
                            {String(field.from || "—")}
                          </span>{" "}
                          → {String(field.to || "—")}
                        </p>
                      ))}
                    </div>
                  )}
                />
              </div>
            </Card>
            <RoomTypePickupOverview summary={pickupSummary} />
            <Card>
              <h2 className="text-lg font-semibold">Requested Rooming List</h2>
              <div className="mt-4 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-gray-500">
                      <th className="p-2">Guest</th>
                      <th className="p-2">Arrival</th>
                      <th className="p-2">Departure</th>
                      <th className="p-2">Room Type</th>
                      <th className="p-2">Guests</th>
                      <th className="p-2">Comment</th>
                      <th className="p-2 text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {requestedReservations.map((reservation) => {
                      const changedReservation = changedReservationsById.get(
                        reservation.id,
                      );
                      const status = removedReservationIds.has(reservation.id)
                        ? "Deleted"
                        : addedReservationIds.has(reservation.id)
                          ? "New"
                          : changedReservationIds.has(reservation.id)
                            ? "Changed"
                            : "";
                      return (
                        <tr
                          key={reservation.id}
                          className={`border-b border-gray-100 ${status === "Deleted" ? "text-gray-500 [&>td:not(:last-child)]:line-through" : ""}`}
                        >
                          <td className="p-2 font-medium">
                            <ChangedValue
                              value={guestName(reservation)}
                              previousValue={
                                changedReservation &&
                                (changedReservation.fields.some(
                                  ({ field }) => field === "firstName",
                                ) ||
                                  changedReservation.fields.some(
                                    ({ field }) => field === "lastName",
                                  ))
                                  ? guestName(changedReservation.before)
                                  : undefined
                              }
                            />
                          </td>
                          <td className="p-2">
                            <ChangedReservationField
                              reservation={reservation}
                              change={changedReservation}
                              field="arrivalDate"
                            />
                          </td>
                          <td className="p-2">
                            <ChangedReservationField
                              reservation={reservation}
                              change={changedReservation}
                              field="departureDate"
                            />
                          </td>
                          <td className="p-2">
                            <ChangedReservationField
                              reservation={reservation}
                              change={changedReservation}
                              field="roomType"
                            />
                          </td>
                          <td className="p-2">
                            <ChangedValue
                              value={`${reservation.numberOfAdults} / ${reservation.numberOfChildren}`}
                              previousValue={
                                changedReservation &&
                                changedReservation.fields.some(({ field }) =>
                                  [
                                    "numberOfAdults",
                                    "numberOfChildren",
                                  ].includes(field),
                                )
                                  ? `${changedReservation.before.numberOfAdults} / ${changedReservation.before.numberOfChildren}`
                                  : undefined
                              }
                            />
                          </td>
                          <td className="p-2">
                            <ChangedReservationField
                              reservation={reservation}
                              change={changedReservation}
                              field="comment"
                              fallback="—"
                            />
                          </td>
                          <td className="p-2 text-right no-underline">
                            {status && <StatusBadge status={status} />}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
            {request.status === "Pending Approval" && (
              <Card>
                <label className="block text-sm font-medium">
                  Rejection reason (optional)
                  <textarea
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    className="mt-2 block min-h-20 w-full rounded-lg border border-gray-300 p-3"
                  />
                </label>
                <div className="mt-4 flex justify-end gap-3">
                  <button
                    disabled={saving}
                    onClick={() => setConfirmDecision("reject")}
                    className="inline-flex items-center gap-2 rounded-lg border border-red-300 px-4 py-2 font-semibold text-red-700"
                  >
                    <X className="h-4 w-4" /> Reject Change Request
                  </button>
                  <button
                    disabled={saving}
                    onClick={() => setConfirmDecision("approve")}
                    className="inline-flex items-center gap-2 rounded-lg bg-green-700 px-4 py-2 font-semibold text-white"
                  >
                    <Check className="h-4 w-4" /> Approve Change Request
                  </button>
                </div>
              </Card>
            )}
            <ConfirmationModal
              decision={confirmDecision}
              saving={saving}
              onCancel={() => setConfirmDecision("")}
              onConfirm={() => {
                const decision = confirmDecision;
                setConfirmDecision("");
                review(decision);
              }}
            />
          </>
        )}
      </PageContainer>
    </div>
  );
}

function ConfirmationModal({ decision, saving, onCancel, onConfirm }) {
  if (!decision) return null;
  const approving = decision === "approve";
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onCancel}
        aria-hidden="true"
      />
      <div
        className="relative z-[80] w-full max-w-md rounded-2xl bg-white p-6 text-center shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="change-request-confirmation-title"
      >
        <h2
          id="change-request-confirmation-title"
          className="text-xl font-semibold text-gray-900"
        >
          {approving ? "Approve Change Request" : "Reject Change Request"}
        </h2>
        <p className="mt-3 text-sm leading-6 text-gray-600">
          Are you sure you want to {approving ? "approve" : "reject"} this
          change request? This decision will be communicated to the organiser.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-200"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={saving}
            className={`rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60 ${approving ? "bg-green-700 hover:bg-green-800" : "bg-[#b41f1f] hover:bg-[#961919]"}`}
          >
            {approving ? "Approve" : "Reject"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RoomTypePickupOverview({ summary }) {
  const [selectedDate, setSelectedDate] = useState("");
  const selectedDay = summary.days.find((day) => day.date === selectedDate);
  const pickupChange =
    summary.totals.requestedPickedUp - summary.totals.officialPickedUp;
  return (
    <Card>
      <div>
        <h2 className="text-lg font-semibold">Room Types by Day</h2>
        <p className="mt-1 text-sm text-gray-600">
          Pickup in the requested list compared with the current official
          version. Remaining is the number of blocked room nights still
          available to pick up.
        </p>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Total Blocked" value={summary.totals.blocked} />
        <Metric
          label="Official Picked Up"
          value={summary.totals.officialPickedUp}
        />
        <Metric
          label="Requested Picked Up"
          value={summary.totals.requestedPickedUp}
          detail={`${pickupChange >= 0 ? "+" : ""}${pickupChange} change`}
          tone={pickupChange === 0 ? "neutral" : "changed"}
        />
        <Metric label="Still Available" value={summary.totals.remaining} />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {summary.days.map((day) => (
          <button
            key={day.date}
            type="button"
            onClick={() => setSelectedDate(day.date)}
            className={`rounded-full px-3 py-1 text-xs font-semibold ${day.date === selectedDay?.date ? "bg-[#b41f1f] text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
          >
            {new Date(`${day.date}T00:00:00`).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })}
          </button>
        ))}
      </div>
      {selectedDay && (
        <div className="mt-5">
          <section className="rounded-xl border border-gray-200 bg-gray-50 p-4">
            {(() => {
              const day = selectedDay;
              return (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="font-semibold text-gray-900">
                        {new Date(`${day.date}T00:00:00`).toLocaleDateString(
                          undefined,
                          { weekday: "short", month: "short", day: "numeric" },
                        )}
                      </h3>
                      <p className="text-xs text-gray-500">{day.date}</p>
                    </div>
                    <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-gray-700 shadow-sm">
                      {day.remaining} remaining
                    </span>
                  </div>
                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    {day.roomTypes.map((roomType) => (
                      <div
                        key={`${day.date}-${roomType.code}`}
                        className={`rounded-lg border p-3 text-sm shadow-sm ${roomType.pickupChange === 0 ? "border-gray-100 bg-white" : "border-amber-200 bg-amber-50"}`}
                      >
                        <div className="flex justify-between gap-3">
                          <p className="font-semibold">
                            {roomType.code}{" "}
                            <span className="font-normal text-gray-500">
                              {roomType.name}
                            </span>
                          </p>
                          {roomType.pickupChange !== 0 && (
                            <span className="font-semibold text-amber-800">
                              {roomType.pickupChange > 0 ? "+" : ""}
                              {roomType.pickupChange}
                            </span>
                          )}
                        </div>
                        <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-gray-600">
                          <p>
                            Blocked
                            <br />
                            <b className="text-gray-900">{roomType.blocked}</b>
                          </p>
                          <p>
                            Picked up
                            <br />
                            <b className="text-gray-900">
                              {roomType.requestedPickedUp}
                            </b>
                          </p>
                          <p>
                            Remaining
                            <br />
                            <b className="text-gray-900">
                              {roomType.remaining}
                            </b>
                          </p>
                        </div>
                        {roomType.pickupChange !== 0 && (
                          <p className="mt-2 text-xs text-amber-800">
                            Official pickup: {roomType.officialPickedUp} →
                            Requested: {roomType.requestedPickedUp}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 flex justify-between border-t border-gray-200 pt-3 text-xs font-semibold text-gray-700">
                    <span>{day.requestedPickedUp} picked up</span>
                    <span>{day.blocked} blocked</span>
                  </div>
                </>
              );
            })()}
          </section>
        </div>
      )}
    </Card>
  );
}

function StatusBadge({ status }) {
  const styles =
    status === "Deleted"
      ? "bg-red-100 text-red-700"
      : status === "New"
        ? "bg-green-100 text-green-700"
        : "bg-amber-100 text-amber-800";
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold no-underline ${styles}`}
    >
      {status}
    </span>
  );
}

function ChangedReservationField({
  reservation,
  change,
  field,
  fallback = "—",
}) {
  const changedField = change?.fields.find((item) => item.field === field);
  return (
    <ChangedValue
      value={reservation[field] || fallback}
      previousValue={changedField ? changedField.from || fallback : undefined}
    />
  );
}

function ChangedValue({ value, previousValue }) {
  return (
    <div>
      <span>{value}</span>
      {previousValue !== undefined && previousValue !== value && (
        <span className="mt-0.5 block text-xs font-medium text-amber-700 no-underline">
          Changed from <span className="line-through">{previousValue}</span>
        </span>
      )}
    </div>
  );
}

function Metric({ label, value, detail, tone = "neutral" }) {
  return (
    <div
      className={`rounded-xl border p-4 ${tone === "changed" ? "border-amber-200 bg-amber-50" : "border-gray-200 bg-gray-50"}`}
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold text-gray-900">{value}</p>
      {detail && (
        <p className="mt-1 text-xs font-semibold text-amber-800">{detail}</p>
      )}
    </div>
  );
}

function ChangeGroup({ title, tone, items, render }) {
  const styles = {
    green: "border-green-200 bg-green-50",
    red: "border-red-200 bg-red-50",
    amber: "border-amber-200 bg-amber-50",
  };
  return (
    <section className={`rounded-xl border p-4 ${styles[tone]}`}>
      <h3 className="font-semibold">
        {title} ({items.length})
      </h3>
      <div className="mt-3 space-y-3">
        {items.length ? (
          items.map((item, index) => (
            <div
              key={item.id || index}
              className="rounded-lg bg-white p-3 text-sm shadow-sm"
            >
              {render(item)}
            </div>
          ))
        ) : (
          <p className="text-sm text-gray-500">No reservations.</p>
        )}
      </div>
    </section>
  );
}
