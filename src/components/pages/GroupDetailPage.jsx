import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, BedDouble, CalendarDays, Mail, Pencil, Phone, UserRound } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { usePermission } from "../../hooks/usePermission";
import { getGroup } from "../../services/firebaseGroups";

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
  const [group, setGroup] = useState(null);
  const [loading, setLoading] = useState(true);
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

    async function loadGroup() {
      if (!hotelUid || !groupId) return;
      setLoading(true);
      setError("");
      try {
        const result = await getGroup(hotelUid, groupId);
        if (!active) return;
        setGroup(result);
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
              <DetailItem label="Block Code" value={group.blockCode} />
              <DetailItem icon={UserRound} label="M&E Officer" value={group.meOfficer} />
              <DetailItem icon={UserRound} label="Organiser" value={group.organiserName} />
              <DetailItem icon={Mail} label="Organiser Email" value={group.organiserEmail} />
              <DetailItem icon={Phone} label="Organiser Phone" value={group.organiserPhone} />
            </div>

            <Card className="border border-gray-100 bg-white/95 shadow-sm">
              <h2 className="text-lg font-semibold">Daily Room Type Allowances</h2>
              <div className="mt-4 space-y-4">
                {roomTypeDays.length === 0 ? (
                  <p className="text-sm text-gray-600">No room type allowances have been added.</p>
                ) : (
                  roomTypeDays.map((day) => (
                    <div key={day.date} className="rounded-xl border border-gray-200 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <h3 className="font-semibold text-gray-900">{formatDate(day.date)}</h3>
                          <p className="text-xs text-gray-500">{day.date}</p>
                        </div>
                        <span className="rounded-full bg-red-50 px-3 py-1 text-sm font-semibold text-[#b41f1f]">
                          {(day.roomTypes || []).reduce((total, roomType) => total + Number(roomType.quantity || 0), 0)} rooms
                        </span>
                      </div>
                      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {(day.roomTypes || []).map((roomType, index) => (
                          <div key={`${day.date}-${roomType.code || index}`} className="rounded-lg bg-gray-50 px-3 py-2 text-sm">
                            <p className="font-semibold text-gray-900">{roomType.code} - {roomType.name}</p>
                            <p className="text-gray-600">Quantity: {roomType.quantity || 0}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </Card>
          </>
        )}
      </PageContainer>
    </div>
  );
}
