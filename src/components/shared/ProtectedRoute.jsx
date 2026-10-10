import React from "react";
import { Navigate } from "react-router-dom";
import { useHotelContext } from "../../contexts/HotelContext";
import { hasPermission } from "../../utils/permissions";
import { auth, authPolicy } from "../../firebaseConfig";
import { multiFactor } from "firebase/auth";
import SubscriptionAccessPage from "../pages/SubscriptionAccessPage";
import { featureIsLicensed, modulesAreValid } from "../../constants/moduleCatalog";

export default function ProtectedRoute({ children, feature, action = "read", anyOf = [], platformOnly = false, hotelAdminOnly = false }) {
  const { hotelUid, loading, authLoading, hotelUids, permissionsLoading, permissions, isPlatformAdmin,
    subscriptionLoading, subscriptionActive, subscription, isHotelAdmin } = useHotelContext();
  const permissionChecks = anyOf.length ? anyOf : feature ? [{ feature, action }] : [];
  const hasAccess = (permissionChecks.length
    ? permissionChecks.some((permission) => featureIsLicensed(subscription, permission.feature)
      && hasPermission({ permissions }, permission.feature, permission.action || "read"))
    : true);

  if (platformOnly ? (authLoading ?? loading) : loading || permissionsLoading || subscriptionLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-600">
        Checking hotel access...
      </div>
    );
  }

  const user = auth.currentUser;
  const authenticationComplete = Boolean(
    user?.emailVerified && (!authPolicy.requireMfa || multiFactor(user).enrolledFactors.length),
  );

  if (!authenticationComplete) {
    return <Navigate to="/login" replace />;
  }

  if (platformOnly) {
    return isPlatformAdmin ? children : <Navigate to={hotelUids?.length ? "/dashboard" : "/access"} replace />;
  }
  if (!hotelUid) return <Navigate to={isPlatformAdmin ? "/platform" : "/access"} replace />;
  if (subscriptionActive !== true || !modulesAreValid(subscription)) {
    return <SubscriptionAccessPage />;
  }

  if (!hasAccess) {
    return <Navigate to="/dashboard" replace />;
  }

  if (hotelAdminOnly && !isHotelAdmin) return <Navigate to="/dashboard" replace />;

  return children;
}
