import { Navigate } from "react-router-dom";
import { useHotelContext } from "../../contexts/HotelContext";
import { hasPermission } from "../../utils/permissions";

export default function ProtectedRoute({ children, feature, action = "read", anyOf = [] }) {
  const { hotelUid, loading, permissionsLoading, permissions } = useHotelContext();
  const permissionChecks = anyOf.length ? anyOf : feature ? [{ feature, action }] : [];
  const hasAccess = permissionChecks.length
    ? permissionChecks.some((permission) => hasPermission({ permissions }, permission.feature, permission.action || "read"))
    : true;

  if (loading || permissionsLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-600">
        ⏳ Bezig met controleren...
      </div>
    );
  }

  if (!hotelUid) {
    return <Navigate to="/login" replace />;
  }

  if (!hasAccess) {
    return <Navigate to="/dashboard" replace />;
  }

  return children;
}
