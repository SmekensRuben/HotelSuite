import React, { useRef, useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { multiFactor } from "firebase/auth";
import { auth, authPolicy } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import ProtectedRoute from "./ProtectedRoute";

export default function PurchaseRequestRoute({ children, action = "read" }) {
  const context = useHotelContext(), location = useLocation();
  const targetHotel = new URLSearchParams(location.search).get("hotel");
  const [switching, setSwitching] = useState(false), [error, setError] = useState("");
  const current = useRef(null), actor = auth.currentUser;
  const scope = `${actor?.uid || ""}:${context.hotelUid || ""}:${targetHotel || ""}`;
  current.current = scope;
  if (context.loading || context.authLoading) return <p role="status" className="p-6 text-gray-600">Checking hotel access...</p>;
  if (!actor?.emailVerified || authPolicy.requireMfa && !multiFactor(actor).enrolledFactors.length) {
    return <Navigate to="/login" replace state={{ purchaseRequestReturn: location.pathname + location.search + location.hash }} />;
  }
  if (targetHotel && targetHotel !== context.hotelUid) {
    const assigned = context.hotelUids?.includes(targetHotel);
    const switchHotel = async () => {
      if (switching || !assigned) return;
      setSwitching(true); setError("");
      try { await context.selectHotel(targetHotel); }
      catch { if (current.current === scope && auth.currentUser === actor) setError("The hotel could not be selected. Try again."); }
      finally { if (current.current === scope && auth.currentUser === actor) setSwitching(false); }
    };
    return <main className="mx-auto max-w-xl space-y-4 p-6">
      <h1 className="text-2xl font-semibold text-brand-950">Open purchase request</h1>
      {assigned ? <>
        <p className="text-sm text-gray-600">This link belongs to hotel {targetHotel}. Select that hotel to check your access and open the request.</p>
        <button type="button" className="ht-button-primary" disabled={switching} onClick={switchHotel}>{switching ? "Selecting hotel..." : "Switch hotel and open request"}</button>
      </> : <p role="alert">Your account is not assigned to the hotel in this link. Sign in with an assigned account or contact your hotel administrator.</p>}
      {error && <p role="alert" className="text-red-700">{error}</p>}
      <Link className="block text-sm text-brand-800 underline" to="/dashboard">Back to workspace</Link>
    </main>;
  }
  return <ProtectedRoute feature="purchaserequests" action={action}>{children}</ProtectedRoute>;
}
