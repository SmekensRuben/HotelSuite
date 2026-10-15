import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { multiFactor } from "firebase/auth";
import { useAuthContext } from "../../contexts/AuthContext";
import { authPolicy } from "../../firebaseConfig";
import { mcpConnectionReturnPath } from "../../utils/mcpConnectionLink";

// Personal grants belong to the signed-in account, independently of hotel or
// platform roles. Every operational tool still checks its explicit hotel.
export default function PersonalAccountRoute({ children }) {
  const { currentUser, authLoading } = useAuthContext();
  const location = useLocation();
  if (authLoading) return <p role="status" className="p-8">Checking account access...</p>;
  if (!currentUser?.emailVerified || (authPolicy.requireMfa && !multiFactor(currentUser).enrolledFactors.length)) {
    const mcpReturn = mcpConnectionReturnPath(location.pathname + location.search);
    return <Navigate to="/login" replace state={mcpReturn ? { mcpReturn } : undefined} />;
  }
  return children;
}
