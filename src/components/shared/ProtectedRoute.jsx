import React from "react";
import { Navigate } from "react-router-dom";
import { useHotelContext } from "../../contexts/HotelContext";
import { hasPermission } from "../../utils/permissions";
import { auth } from "../../firebaseConfig";
import { multiFactor } from "firebase/auth";

export default function ProtectedRoute({ children, feature, action = "read", anyOf = [], platformOnly = false }) {
  const { hotelUid, loading, permissionsLoading, permissions, isPlatformAdmin } = useHotelContext();
  const permissionChecks = anyOf.length ? anyOf : feature ? [{ feature, action }] : [];
  const hasAccess = isPlatformAdmin || (permissionChecks.length
    ? permissionChecks.some((permission) => hasPermission({ permissions }, permission.feature, permission.action || "read"))
    : true);

  if (loading || permissionsLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-600">
        ⏳ Bezig met controleren...
      </div>
    );
  }

  const user = auth.currentUser;
  const authenticationComplete = Boolean(
    user?.emailVerified && multiFactor(user).enrolledFactors.length,
  );

  if (!hotelUid || !authenticationComplete) {
    return <Navigate to="/login" replace />;
  }

  if (!hasAccess) {
    return <Navigate to="/dashboard" replace />;
  }

  if (platformOnly && !isPlatformAdmin) {
    return <Navigate to="/dashboard" replace />;
  }

  return children;
}
