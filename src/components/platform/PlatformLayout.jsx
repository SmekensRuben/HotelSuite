import React from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { Building2, LayoutDashboard, FileText, Activity, Bell, ScrollText, Users, LogOut, ArrowRight } from "lucide-react";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";

const links = [["/platform", "Overview", LayoutDashboard], ["/platform/hotels", "Hotels", Building2],
  ["/platform/subscriptions", "Subscriptions", FileText], ["/platform/imports", "Imports & integrations", Activity],
  ["/platform/incidents", "Notifications", Bell], ["/platform/activity", "Activity & audit", ScrollText], ["/platform/users", "Users", Users]];
export default function PlatformLayout() {
  const { hotelUid, hotelUids, selectHotel } = useHotelContext();
  const navigate = useNavigate();
  const enterHotel = async () => { if (hotelUid || hotelUids.length) { await selectHotel(hotelUid || hotelUids[0]); navigate("/dashboard"); } };
  return <div className="min-h-screen bg-[#f5f6f8] text-slate-900">
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 bg-white px-6 py-4">
      <NavLink to="/platform" className="text-lg font-semibold tracking-tight">Hotel Toolkit <span className="ml-2 rounded-md bg-slate-900 px-2 py-1 text-xs text-white">Platform</span></NavLink>
      <div className="flex items-center gap-3">{hotelUids.length > 0 && <button className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm" onClick={enterHotel}>Hotel workspace <ArrowRight size={16} /></button>}
        <button className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-600" onClick={() => signOut(auth)}><LogOut size={16} />Sign out</button></div>
    </header>
    <div className="mx-auto grid max-w-[1600px] gap-6 p-4 lg:grid-cols-[230px_minmax(0,1fr)] lg:p-6">
      <aside><nav aria-label="Platform navigation" className="flex flex-wrap gap-1 lg:sticky lg:top-6 lg:flex-col">
        {links.map(([to, label, Icon]) => <NavLink key={to} to={to} end={to === "/platform"} className={({ isActive }) => `flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium ${isActive ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-white"}`}><Icon size={18} aria-hidden="true" />{label}</NavLink>)}
      </nav><p className="mt-6 hidden px-4 text-xs leading-5 text-slate-500 lg:block">Platform administration is separate from hotel work. Hotel work uses your assigned membership and licensed modules.</p></aside>
      <main className="min-w-0"><Outlet /></main>
    </div>
  </div>;
}
