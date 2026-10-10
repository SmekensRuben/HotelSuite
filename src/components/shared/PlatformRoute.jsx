import React from "react";
import { Navigate } from "react-router-dom";
import { multiFactor } from "firebase/auth";
import { useAuthContext } from "../../contexts/AuthContext";
import { authPolicy } from "../../firebaseConfig";
import { workspaceHome } from "../../utils/workspace";

export default function PlatformRoute({ children }) {
  const { currentUser, authLoading, isPlatformAdmin, hotelUids } = useAuthContext();
  if (authLoading) return <p role="status" className="p-8">Checking platform access...</p>;
  if (!currentUser?.emailVerified || (authPolicy.requireMfa && !multiFactor(currentUser).enrolledFactors.length)) {
    return <Navigate to="/login" replace />;
  }
  if (!isPlatformAdmin) return <Navigate to={workspaceHome({ hotelUids })} replace />;
  return children;
}
