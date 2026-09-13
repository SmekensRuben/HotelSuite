import React, { useEffect, useState } from "react";
import { ArrowLeft, Save } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "react-toastify";
import { useHotelContext } from "../../contexts/HotelContext";
import { EMPTY_EVENT, validateDemandCalendarEvent } from "../../constants/demandCalendar";
import { createDemandCalendarEvent, getDemandCalendarEvent, subscribeDemandCalendarCategories, updateDemandCalendarEvent } from "../../services/firebaseDemandCalendar";
import DemandCalendarShell from "./DemandCalendarShell";
import DemandCalendarEventForm from "./DemandCalendarEventForm";

export default function DemandCalendarEventEditorPage() {
  const { eventId } = useParams(); const editing = Boolean(eventId); const { hotelUid } = useHotelContext(); const navigate = useNavigate();
  const [event, setEvent] = useState(EMPTY_EVENT); const [categories, setCategories] = useState([]); const [loading, setLoading] = useState(editing); const [saving, setSaving] = useState(false); const [errors, setErrors] = useState({});
  useEffect(() => subscribeDemandCalendarCategories(hotelUid, setCategories, () => toast.error("Categories could not be loaded.")), [hotelUid]);
  useEffect(() => { if (!editing || !hotelUid) return; getDemandCalendarEvent(hotelUid, eventId).then((item) => { if (item) setEvent({ ...EMPTY_EVENT, ...item }); setLoading(false); }); }, [editing, eventId, hotelUid]);
  const save = async (e) => { e.preventDefault(); const validation = validateDemandCalendarEvent(event); setErrors(validation); if (Object.keys(validation).length) return;
    setSaving(true); try { const payload = { ...event, expectedAttendance: event.expectedAttendance === "" ? null : Number(event.expectedAttendance) }; delete payload.id; delete payload.createdAt; delete payload.updatedAt;
      const id = editing ? (await updateDemandCalendarEvent(hotelUid, eventId, payload), eventId) : await createDemandCalendarEvent(hotelUid, payload); toast.success(editing ? "Calendar event updated." : "Calendar event created."); navigate(`/me/demand-calendar/${id}`);
    } catch { toast.error("The calendar event could not be saved."); } finally { setSaving(false); } };
  return <DemandCalendarShell><div className="flex items-center gap-3"><button type="button" onClick={() => navigate(editing ? `/me/demand-calendar/${eventId}` : "/me/demand-calendar")} className="rounded-lg border bg-white p-2"><ArrowLeft className="h-5 w-5" /></button><div><p className="text-sm uppercase tracking-wide text-gray-500">M&amp;E / Demand Calendar</p><h1 className="text-3xl font-semibold">{editing ? "Edit Calendar Event" : "Create Calendar Event"}</h1></div></div>
    {loading ? <p>Loading calendar event…</p> : <form onSubmit={save}><DemandCalendarEventForm value={event} setValue={setEvent} errors={errors} categories={categories} />{!categories.length && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">Create an active category before adding a calendar event.</p>}<div className="mt-6 flex justify-end"><button disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-[#b41f1f] px-5 py-2 font-semibold text-white disabled:bg-gray-400"><Save className="h-4 w-4" />{saving ? "Saving…" : "Save Calendar Event"}</button></div></form>}
  </DemandCalendarShell>;
}
