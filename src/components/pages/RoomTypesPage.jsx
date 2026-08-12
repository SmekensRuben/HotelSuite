import React, { useMemo, useState } from "react";
import { ArrowLeft, Pencil, Plus, Trash2, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { addRoomType, deleteRoomType, subscribeRoomTypes, updateRoomType } from "../../services/firebaseRoomTypes";

const emptyForm = { code: "", description: "", amount: "" };

export default function RoomTypesPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [roomTypes, setRoomTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const todayLabel = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);

  React.useEffect(() => {
    setLoading(true);
    setError("");
    const unsubscribe = subscribeRoomTypes(
      hotelUid,
      (items) => { setRoomTypes(items); setLoading(false); },
      (err) => {
        console.error("Unable to load Room Types:", err);
        setError("The Room Types could not be loaded from Firebase.");
        setLoading(false);
      }
    );
    if (!hotelUid) setLoading(false);
    return unsubscribe;
  }, [hotelUid]);

  const resetForm = () => { setEditingId(null); setForm(emptyForm); setError(""); };
  const save = async (event) => {
    event.preventDefault();
    const amount = Number(form.amount);
    const payload = { code: form.code.trim(), description: form.description.trim(), amount };
    if (!payload.code || !payload.description || !Number.isInteger(amount) || amount < 0) {
      setError("Enter a code, description and a valid non-negative room amount.");
      return;
    }
    setSaving(true); setError("");
    try {
      if (editingId) await updateRoomType(hotelUid, editingId, payload);
      else await addRoomType(hotelUid, payload);
      resetForm();
    } catch (err) {
      console.error("Unable to save Room Type:", err);
      setError("The Room Type could not be saved in Firebase.");
    } finally { setSaving(false); }
  };

  const handleLogout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={todayLabel} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div>
          <button onClick={() => navigate("/settings/property")} className="mb-3 inline-flex items-center gap-2 text-sm font-semibold text-blue-700"><ArrowLeft className="h-4 w-4" />Property Settings</button>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div><p className="text-sm uppercase tracking-wide text-gray-500">Property Settings</p><h1 className="text-3xl font-semibold">Room Types</h1><p className="mt-2 text-gray-600">Manage the room types and available room count for this property.</p></div>
            {!editingId && form === emptyForm && <button onClick={() => setForm({ ...emptyForm })} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"><Plus className="h-4 w-4" />Add Room Type</button>}
          </div>
        </div>

        {(editingId || form !== emptyForm) && <Card className="max-w-3xl">
          <div className="flex justify-between"><h2 className="text-lg font-semibold">{editingId ? "Edit Room Type" : "New Room Type"}</h2><button aria-label="Close form" onClick={resetForm}><X className="h-5 w-5" /></button></div>
          <form onSubmit={save} className="mt-4 grid gap-4 sm:grid-cols-[9rem_1fr_8rem_auto] sm:items-end">
            <label className="text-sm font-semibold">Code<input aria-label="Room type code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2 font-normal" /></label>
            <label className="text-sm font-semibold">Description<input aria-label="Room type description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2 font-normal" /></label>
            <label className="text-sm font-semibold">Amount<input aria-label="Room type amount" type="number" min="0" step="1" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2 font-normal" /></label>
            <button disabled={saving} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">{saving ? "Saving..." : "Save"}</button>
          </form>
          {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
        </Card>}

        <Card className="overflow-hidden p-0">
          {loading ? <p className="p-6 text-sm text-gray-500">Loading Room Types...</p> : roomTypes.length === 0 ? <div className="p-8 text-center"><h2 className="font-semibold">No Room Types yet</h2><p className="mt-1 text-sm text-gray-500">Add the first Room Type to start configuring this property.</p></div> : <div className="divide-y divide-gray-200">{roomTypes.map((roomType) => <div key={roomType.id} className="grid gap-3 p-5 sm:grid-cols-[8rem_1fr_8rem_auto] sm:items-center"><span className="font-mono text-sm font-semibold">{roomType.code}</span><span>{roomType.description}</span><span className="text-sm text-gray-600">{roomType.amount} rooms</span><div className="flex gap-2"><button aria-label={`Edit ${roomType.code}`} onClick={() => { setEditingId(roomType.id); setForm({ code: roomType.code || "", description: roomType.description || "", amount: String(roomType.amount ?? "") }); }} className="rounded-lg border p-2 text-blue-700"><Pencil className="h-4 w-4" /></button><button aria-label={`Delete ${roomType.code}`} onClick={async () => { if (window.confirm(`Delete Room Type ${roomType.code}?`)) await deleteRoomType(hotelUid, roomType.id); }} className="rounded-lg border p-2 text-red-700"><Trash2 className="h-4 w-4" /></button></div></div>)}</div>}
        </Card>
      </PageContainer>
    </div>
  );
}
