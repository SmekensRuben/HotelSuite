import React from "react";
import { Outlet, useNavigate } from "react-router-dom";
import {
  Building2,
  LayoutDashboard,
  FileText,
  Activity,
  Bell,
  ScrollText,
  Users,
  LogOut,
  ArrowRight,
} from "lucide-react";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import WorkspaceChrome from "../layout/WorkspaceChrome";

const links = [
  ["/platform", "Overview", LayoutDashboard],
  ["/platform/hotels", "Hotels", Building2],
  ["/platform/subscriptions", "Subscriptions", FileText],
  ["/platform/imports", "Imports & integrations", Activity],
  ["/platform/incidents", "Notifications", Bell],
  ["/platform/activity", "Activity & audit", ScrollText],
  ["/platform/users", "Users", Users],
];
export default function PlatformLayout() {
  const { hotelUid, hotelUids, selectHotel } = useHotelContext();
  const navigate = useNavigate();
  const enterHotel = async () => {
    if (hotelUid || hotelUids.length) {
      await selectHotel(hotelUid || hotelUids[0]);
      navigate("/dashboard");
    }
  };
  const groups = [
    {
      label: "Platform administration",
      items: links.map(([to, label, icon]) => ({
        to,
        label,
        icon,
        end: to === "/platform",
      })),
    },
  ];
  return (
    <div className="min-h-screen bg-canvas text-gray-900">
      <WorkspaceChrome
        platform
        groups={groups}
        subtitle="Platform administration"
        footer="Manage connected hotels here. Hotel work uses your assigned membership and licensed modules."
        actions={
          <>
            {hotelUids.length > 0 && (
              <button
                className="ht-icon-button sm:w-auto sm:gap-2 sm:px-3"
                aria-label="Hotel workspace"
                onClick={enterHotel}
              >
                <span className="hidden text-xs sm:inline">
                  Hotel workspace
                </span>
                <ArrowRight size={16} />
              </button>
            )}
            <button
              className="ht-icon-button sm:w-auto sm:gap-2 sm:px-3"
              onClick={() => signOut(auth)}
              aria-label="Sign out"
            >
              <LogOut size={16} />
              <span className="hidden text-xs font-medium sm:inline">
                Sign out
              </span>
            </button>
          </>
        }
      />
      <main id="platform-content" tabIndex={-1} className="ht-page-container">
        <Outlet />
      </main>
    </div>
  );
}
