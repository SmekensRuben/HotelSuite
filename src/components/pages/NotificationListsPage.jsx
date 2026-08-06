import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, BellRing, Pencil, Plus, Trash2, UserPlus } from "lucide-react";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { deleteNotificationList, getNotificationLists, saveNotificationList } from "../../services/firebaseNotificationLists";

const emptyList = () => ({ title: "", contacts: [{ name: "", email: "" }] });

export default function NotificationListsPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [lists, setLists] = useState([]);
  const [form, setForm] = useState(emptyList);
  const [editingId, setEditingId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const today = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);

  const refresh = async () => setLists(await getNotificationLists(hotelUid));
  useEffect(() => { if (hotelUid) refresh().catch(() => setError("Notification Lists could not be loaded.")).finally(() => setLoading(false)); }, [hotelUid]);
  const logout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };
  const updateContact = (index, field, value) => setForm((current) => ({ ...current, contacts: current.contacts.map((contact, i) => i === index ? { ...contact, [field]: value } : contact) }));

  const submit = async (event) => {
    event.preventDefault(); setSaving(true); setError("");
    try {
      await saveNotificationList(hotelUid, { ...form, id: editingId }, auth.currentUser?.uid);
      await refresh(); setForm(emptyList()); setEditingId(null);
    } catch (err) { setError(err?.message || "Notification List could not be saved."); } finally { setSaving(false); }
  };

  return <div className="min-h-screen bg-gray-50 text-gray-900">
    <HeaderBar today={today} onLogout={logout} />
    <PageContainer className="space-y-6 pb-10">
      <div className="flex items-start justify-between gap-4"><div><p className="text-sm uppercase tracking-wide text-gray-500">Settings</p><h1 className="text-3xl font-semibold">Notification Lists</h1><p className="mt-1 text-gray-600">Create reusable lists of contacts for group notifications.</p></div><button onClick={() => navigate("/dashboard")} className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold"><ArrowLeft className="h-4 w-4" /> Back</button></div>
      <div className="grid gap-6 lg:grid-cols-[2fr,3fr]">
        <Card><h2 className="flex items-center gap-2 text-lg font-semibold"><BellRing className="h-5 w-5 text-[#b41f1f]" />{editingId ? "Edit List" : "New List"}</h2>
          <form onSubmit={submit} className="mt-4 space-y-4"><label className="block text-sm font-medium">Title<input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" /></label>
            {form.contacts.map((contact, index) => <div key={index} className="rounded-lg border border-gray-200 p-3"><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm font-medium">Name<input required value={contact.name} onChange={(e) => updateContact(index, "name", e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" /></label><label className="text-sm font-medium">Email<input required type="email" value={contact.email} onChange={(e) => updateContact(index, "email", e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" /></label></div>{form.contacts.length > 1 && <button type="button" onClick={() => setForm({ ...form, contacts: form.contacts.filter((_, i) => i !== index) })} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-red-700"><Trash2 className="h-3.5 w-3.5" /> Remove contact</button>}</div>)}
            <button type="button" onClick={() => setForm({ ...form, contacts: [...form.contacts, { name: "", email: "" }] })} className="inline-flex items-center gap-2 text-sm font-semibold text-[#b41f1f]"><UserPlus className="h-4 w-4" /> Add contact</button>
            {error && <p className="text-sm font-semibold text-red-600">{error}</p>}<div className="flex gap-2"><button disabled={saving} className="rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white">{saving ? "Saving..." : "Save List"}</button>{editingId && <button type="button" onClick={() => { setEditingId(null); setForm(emptyList()); }} className="rounded-lg border px-4 py-2 text-sm font-semibold">Cancel</button>}</div>
          </form></Card>
        <div className="space-y-4">{loading ? <p>Loading Notification Lists...</p> : lists.length === 0 ? <Card><p className="text-gray-600">No Notification Lists created yet.</p></Card> : lists.map((list) => <Card key={list.id}><div className="flex items-start justify-between"><div><h2 className="text-lg font-semibold">{list.title}</h2><p className="text-sm text-gray-500">{list.contacts?.length || 0} contact(s)</p></div><div className="flex gap-2"><button aria-label={`Edit ${list.title}`} onClick={() => { setEditingId(list.id); setForm({ title: list.title, contacts: list.contacts?.length ? list.contacts : [{ name: "", email: "" }] }); }} className="rounded-lg border p-2"><Pencil className="h-4 w-4" /></button><button aria-label={`Delete ${list.title}`} onClick={async () => { if (window.confirm(`Delete ${list.title}?`)) { await deleteNotificationList(hotelUid, list.id); await refresh(); } }} className="rounded-lg border p-2 text-red-700"><Trash2 className="h-4 w-4" /></button></div></div><div className="mt-3 divide-y">{list.contacts?.map((contact, i) => <div key={`${contact.email}-${i}`} className="flex justify-between gap-3 py-2 text-sm"><span className="font-medium">{contact.name}</span><a className="text-[#b41f1f]" href={`mailto:${contact.email}`}>{contact.email}</a></div>)}</div></Card>)}</div>
      </div>
    </PageContainer>
  </div>;
}
