import React from "react";
import { signOut, auth } from "../../firebaseConfig";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";

export default function DashboardPage() {
  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer>
        <Card>
          <h1 className="text-2xl font-semibold text-gray-900">Dashboard</h1>
          <p className="mt-2 text-sm text-gray-600">
            Niet-kernfunctionaliteiten zijn verwijderd. Enkel de kernflow (inloggen,
            multi-property selectie en basisinstellingen) blijft behouden.
          </p>
        </Card>
      </PageContainer>
    </div>
  );
}
