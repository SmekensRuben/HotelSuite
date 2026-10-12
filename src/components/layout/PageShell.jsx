import React, { useMemo } from "react";
import HeaderBar from "./HeaderBar";
import PageContainer from "./PageContainer";
import ProcurementPage from "./ProcurementPage";
import { auth, signOut } from "../../firebaseConfig";

export default function PageShell({
  children,
  className = "space-y-6",
  afterContent,
  variant = "workspace",
  width = "workspace",
}) {
  const Content = variant === "procurement" ? ProcurementPage : PageContainer;
  const today = useMemo(
    () =>
      new Date().toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
    [],
  );
  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };
  return (
    <div className="min-h-screen bg-canvas text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <Content className={className} {...(variant === "procurement" ? { width } : {})}>{children}</Content>
      {afterContent}
    </div>
  );
}
