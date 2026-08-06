import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Settings } from "lucide-react";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import NotificationListSelector from "./NotificationListSelector";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { normalizeNotificationSelections } from "../../constants/groupNotifications";
import { getGroupNotificationDefaults, getNotificationLists, saveGroupNotificationDefaults } from "../../services/firebaseNotificationLists";

export default function GroupSettingsPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [lists, setLists] = useState([]);
  const [defaults, setDefaults] = useState(normalizeNotificationSelections);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const today = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);
  useEffect(() => { let active = true; if (!hotelUid) return; Promise.all([getNotificationLists(hotelUid), getGroupNotificationDefaults(hotelUid)]).then(([available, selected]) => { if (active) { setLists(available); setDefaults(selected); } }).catch(() => active && setError("Group Settings could not be loaded.")).finally(() => active && setLoading(false)); return () => { active = false; }; }, [hotelUid]);
  const logout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };
  const save = async () => { setSaving(true); setError(""); setMessage(""); try { await saveGroupNotificationDefaults(hotelUid, defaults, auth.currentUser?.uid); setMessage("Default Notification Lists saved."); } catch { setError("Default Notification Lists could not be saved."); } finally { setSaving(false); } };
  return <div className="min-h-screen bg-gray-50 text-gray-900"><HeaderBar today={today} onLogout={logout} /><PageContainer className="space-y-6 pb-10">
    <div className="flex items-start justify-between gap-4"><div><p className="flex items-center gap-2 text-sm uppercase tracking-wide text-gray-500"><Settings className="h-4 w-4" /> Groups</p><h1 className="text-3xl font-semibold">Group Settings</h1><p className="mt-1 text-gray-600">Choose which lists are automatically selected when a Group is created.</p></div><button onClick={() => navigate("/me/groups")} className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold"><ArrowLeft className="h-4 w-4" /> Back to Groups</button></div>
    <Card><h2 className="text-lg font-semibold">Default Notification Lists</h2><p className="mb-5 mt-1 text-sm text-gray-600">You can select multiple lists for every Notification. These selections can still be changed on an individual Group.</p>{loading ? <p>Loading settings...</p> : <NotificationListSelector lists={lists} value={defaults} onChange={setDefaults} disabled={saving} />}{error && <p className="mt-4 text-sm font-semibold text-red-600">{error}</p>}{message && <p className="mt-4 text-sm font-semibold text-green-700">{message}</p>}<div className="mt-5 flex justify-end"><button onClick={save} disabled={loading || saving} className="rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white disabled:bg-gray-300">{saving ? "Saving..." : "Save Group Settings"}</button></div></Card>
  </PageContainer></div>;
}
