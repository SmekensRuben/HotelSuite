import { Navigate } from "react-router-dom";
import { useHotelContext } from "../../contexts/HotelContext";
import { usePermission } from "../../hooks/usePermission";

export default function ProtectedRoute({ children, feature, action = "view" }) {
  const { hotelUid, loading } = useHotelContext();
  const hasAccess = feature ? usePermission(feature, action) : true;

  if (loading) {
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
