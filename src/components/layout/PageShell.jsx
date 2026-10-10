import React, { useMemo } from "react";
import HeaderBar from "./HeaderBar";
import PageContainer from "./PageContainer";
import { auth, signOut } from "../../firebaseConfig";

export default function PageShell({ children, className = "space-y-6", afterContent }) {
  const today = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);
  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };
  return <div className="min-h-screen bg-gray-50 text-gray-900"><HeaderBar today={today} onLogout={handleLogout} /><PageContainer className={className}>{children}</PageContainer>{afterContent}</div>;
}
