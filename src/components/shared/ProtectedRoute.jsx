import React from "react";
import { Navigate } from "react-router-dom";
import { useHotelContext } from "../../contexts/HotelContext";
import { hasPermission } from "../../utils/permissions";
import { auth, authPolicy, signOut } from "../../firebaseConfig";
import { multiFactor } from "firebase/auth";

export default function ProtectedRoute({ children, feature, action = "read", anyOf = [], platformOnly = false }) {
  const { hotelUid, loading, permissionsLoading, permissions, isPlatformAdmin,
    subscriptionLoading, subscriptionActive, hotelUids = [], selectHotel } = useHotelContext();
  const permissionChecks = anyOf.length ? anyOf : feature ? [{ feature, action }] : [];
  const hasAccess = isPlatformAdmin || (permissionChecks.length
    ? permissionChecks.some((permission) => hasPermission({ permissions }, permission.feature, permission.action || "read"))
    : true);

  if (loading || permissionsLoading || (!isPlatformAdmin && subscriptionLoading)) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-600">
        ⏳ Bezig met controleren...
      </div>
    );
  }

  const user = auth.currentUser;
  const authenticationComplete = Boolean(
    user?.emailVerified && (!authPolicy.requireMfa || multiFactor(user).enrolledFactors.length),
  );

  if (!hotelUid || !authenticationComplete) {
    return <Navigate to="/login" replace />;
  }

  if (!isPlatformAdmin && subscriptionActive !== true) {
    return <div className="mx-auto max-w-lg space-y-4 p-8">
      <h1 className="text-2xl font-semibold">Geen actief hotelabonnement</h1>
      <p>Neem contact op met de beheerder om de toegang tot dit hotel te activeren.</p>
      {hotelUids.length > 1 && <div className="space-x-3">{hotelUids.map((uid) => <button className="underline" key={uid} onClick={() => selectHotel(uid)}>{uid}</button>)}</div>}
      <button className="underline" onClick={() => signOut(auth)}>Uitloggen</button>
    </div>;
  }

  if (!hasAccess) {
    return <Navigate to="/dashboard" replace />;
  }

  if (platformOnly && !isPlatformAdmin) {
    return <Navigate to="/dashboard" replace />;
  }

  return children;
}
