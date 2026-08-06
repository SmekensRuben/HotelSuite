import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Check, X } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { calculateRoomingListChanges, getRoomingListByToken, reviewRoomingListChangeRequest } from "../../services/firebaseRoomingLists";

const FIELD_LABELS = { firstName: "First Name", lastName: "Last Name", arrivalDate: "Arrival Date", departureDate: "Departure Date", roomType: "Room Type", numberOfAdults: "Adults", numberOfChildren: "Children", comment: "Comment" };
const guestName = (reservation) => `${reservation.firstName || ""} ${reservation.lastName || ""}`.trim() || "Unnamed guest";

export default function RoomingListChangeRequestPage() {
  const { groupId, requestId } = useParams();
  const navigate = useNavigate();
  const [roomingList, setRoomingList] = useState(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { getRoomingListByToken(requestId).then(setRoomingList).catch((err) => setError(err.message)); }, [requestId]);
  const request = (roomingList?.changeRequests || []).find((item) => item.status === "Pending Approval") || (roomingList?.changeRequests || []).at(-1);
  const base = (roomingList?.versions || []).find((version) => version.number === request?.baseVersionNumber)?.reservations || [];
  const changes = request?.changes || calculateRoomingListChanges(base, request?.reservations || []);
  const addedReservationIds = new Set(changes.added.map((reservation) => reservation.id));
  const changedReservationIds = new Set(changes.changed.map((reservation) => reservation.id));

  const review = async (decision) => {
    setSaving(true); setError("");
    try { await reviewRoomingListChangeRequest(requestId, request.id, decision, reason); navigate(`/me/groups/${groupId}`); }
    catch (err) { setError(err?.message || "Unable to review request."); setSaving(false); }
  };
  const logout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };

  return <div className="min-h-screen bg-gray-50"><HeaderBar onLogout={logout} /><PageContainer className="space-y-6 pb-10">
    <button onClick={() => navigate(`/me/groups/${groupId}`)} className="inline-flex items-center gap-2 text-sm font-semibold text-gray-700"><ArrowLeft className="h-4 w-4" /> Back to Group</button>
    {error && <p className="font-semibold text-red-600">{error}</p>}
    {roomingList && request && <>
      <Card className="border-0 bg-gradient-to-r from-[#b41f1f] to-[#7f1717] text-white">
        <p className="text-sm text-red-100">{roomingList.groupName} · Rooming List</p><h1 className="mt-1 text-3xl font-semibold">Change Request {request.number}</h1>
        <div className="mt-4 grid gap-2 text-sm sm:grid-cols-3"><p>Status: <b>{request.status}</b></p><p>Submitted: <b>{request.submittedAt ? new Date(request.submittedAt).toLocaleString() : "—"}</b></p><p>Based on: <b>Version {request.baseVersionNumber}</b></p></div>
      </Card>
      <Card><h2 className="text-lg font-semibold">Changes</h2><div className="mt-4 grid gap-4 lg:grid-cols-3">
        <ChangeGroup title="Added" tone="green" items={changes.added} render={(item) => guestName(item)} />
        <ChangeGroup title="Removed" tone="red" items={changes.removed} render={(item) => guestName(item)} />
        <ChangeGroup title="Changed" tone="amber" items={changes.changed} render={(item) => <div><b>{guestName(item.after)}</b>{item.fields.map((field) => <p key={field.field} className="mt-1 text-xs">{FIELD_LABELS[field.field] || field.field}: <span className="line-through">{String(field.from || "—")}</span> → {String(field.to || "—")}</p>)}</div>} />
      </div></Card>
      <Card><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">Requested Rooming List</h2><div className="flex gap-3 text-xs font-medium text-gray-600"><span className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm border border-green-200 bg-green-50" /> Added</span><span className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm border border-amber-200 bg-amber-50" /> Changed</span></div></div><div className="mt-4 overflow-x-auto"><table className="min-w-full text-sm"><thead><tr className="border-b text-left text-gray-500"><th className="p-2">Guest</th><th className="p-2">Arrival</th><th className="p-2">Departure</th><th className="p-2">Room Type</th><th className="p-2">Guests</th><th className="p-2">Comment</th></tr></thead><tbody>{request.reservations.map((reservation) => { const rowStyle = addedReservationIds.has(reservation.id) ? "border-green-200 bg-green-50" : changedReservationIds.has(reservation.id) ? "border-amber-200 bg-amber-50" : "border-gray-100 bg-white"; return <tr key={reservation.id} className={`border-b ${rowStyle}`}><td className="p-2 font-medium">{guestName(reservation)}</td><td className="p-2">{reservation.arrivalDate}</td><td className="p-2">{reservation.departureDate}</td><td className="p-2">{reservation.roomType}</td><td className="p-2">{reservation.numberOfAdults} / {reservation.numberOfChildren}</td><td className="p-2">{reservation.comment || "—"}</td></tr>; })}</tbody></table></div></Card>
      {request.status === "Pending Approval" && <Card><label className="block text-sm font-medium">Rejection reason (optional)<textarea value={reason} onChange={(event) => setReason(event.target.value)} className="mt-2 block min-h-20 w-full rounded-lg border border-gray-300 p-3" /></label><div className="mt-4 flex justify-end gap-3"><button disabled={saving} onClick={() => review("reject")} className="inline-flex items-center gap-2 rounded-lg border border-red-300 px-4 py-2 font-semibold text-red-700"><X className="h-4 w-4" /> Reject Change Request</button><button disabled={saving} onClick={() => review("approve")} className="inline-flex items-center gap-2 rounded-lg bg-green-700 px-4 py-2 font-semibold text-white"><Check className="h-4 w-4" /> Approve Change Request</button></div></Card>}
    </>}
  </PageContainer></div>;
}

function ChangeGroup({ title, tone, items, render }) {
  const styles = { green: "border-green-200 bg-green-50", red: "border-red-200 bg-red-50", amber: "border-amber-200 bg-amber-50" };
  return <section className={`rounded-xl border p-4 ${styles[tone]}`}><h3 className="font-semibold">{title} ({items.length})</h3><div className="mt-3 space-y-3">{items.length ? items.map((item, index) => <div key={item.id || index} className="rounded-lg bg-white p-3 text-sm shadow-sm">{render(item)}</div>) : <p className="text-sm text-gray-500">No reservations.</p>}</div></section>;
}
