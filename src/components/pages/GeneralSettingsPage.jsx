import React, { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { BedDouble, BadgeDollarSign, ChevronRight, SlidersHorizontal } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";

const options = [
  { title: "Room Types", description: "Create, view, edit and delete the room types for this property.", icon: BedDouble, path: "/settings/property/room-types", available: true },
  { title: "Rate Codes", description: "Manage the rate codes available for this property.", icon: BadgeDollarSign },
  { title: "Option X", description: "Additional property configuration will be available here.", icon: SlidersHorizontal },
  { title: "Option Y", description: "Additional property configuration will be available here.", icon: SlidersHorizontal },
];

export default function GeneralSettingsPage() {
  const navigate = useNavigate();
  const todayLabel = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);
  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={todayLabel} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div>
          <p className="text-sm uppercase tracking-wide text-gray-500">Settings</p>
          <h1 className="text-3xl font-semibold">Property Settings</h1>
          <p className="mt-2 text-gray-600">Choose which property configuration you want to manage.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {options.map(({ title, description, icon: Icon, path, available }) => (
            <Card key={title} className={`flex min-h-44 flex-col justify-between ${available ? "transition hover:-translate-y-0.5 hover:shadow-md" : "opacity-65"}`}>
              <div>
                <div className="flex items-start justify-between gap-4">
                  <span className="rounded-xl bg-blue-50 p-3 text-blue-700"><Icon className="h-6 w-6" /></span>
                  {!available && <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-600">Coming later</span>}
                </div>
                <h2 className="mt-4 text-lg font-semibold">{title}</h2>
                <p className="mt-1 text-sm text-gray-600">{description}</p>
              </div>
              {available && (
                <button type="button" onClick={() => navigate(path)} className="mt-5 inline-flex items-center gap-1 self-start text-sm font-semibold text-blue-700 hover:text-blue-900">
                  Manage {title}<ChevronRight className="h-4 w-4" />
                </button>
              )}
            </Card>
          ))}
        </div>
      </PageContainer>
    </div>
  );
}
