import React, { useMemo } from "react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { auth, signOut } from "../../firebaseConfig";

export default function DemandCalendarShell({ children }) {
  const today = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);
  const logout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };
  return <div className="min-h-screen bg-gray-50 text-gray-900"><HeaderBar today={today} onLogout={logout} /><PageContainer className="space-y-6">{children}</PageContainer></div>;
}
