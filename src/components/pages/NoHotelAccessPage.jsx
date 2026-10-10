import React from "react";
import { Navigate } from "react-router-dom";
import { auth, signOut } from "../../firebaseConfig";
import { useAuthContext } from "../../contexts/AuthContext";

export default function NoHotelAccessPage() {
  const { authLoading, authError, currentUser, isPlatformAdmin, hotelUids } = useAuthContext();
  if (authLoading) return <p role="status" className="p-8">Checking access...</p>;
  if (!currentUser?.emailVerified) return <Navigate to="/login" replace />;
  if (isPlatformAdmin) return <Navigate to="/platform" replace />;
  if (hotelUids.length) return <Navigate to="/dashboard" replace />;
  if (authError) return <main className="mx-auto max-w-xl p-8"><h1 className="text-2xl font-semibold">Account access unavailable</h1><p className="mt-4">Your account could not be checked. Sign in again to retry.</p><button className="mt-6 rounded-lg border px-4 py-2" onClick={() => signOut(auth)}>Sign out</button></main>;
  return <main className="mx-auto max-w-xl p-8"><h1 className="text-2xl font-semibold">No hotel assigned</h1>
    <p className="mt-4">Ask your hotel administrator to invite you. Hotel access is assigned to your named account.</p>
    <button className="mt-6 rounded-lg border px-4 py-2" onClick={() => signOut(auth)}>Sign out</button></main>;
}
