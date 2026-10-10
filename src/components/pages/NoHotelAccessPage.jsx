import React from "react";
import { Navigate } from "react-router-dom";
import { Building2 } from "lucide-react";
import { auth, signOut } from "../../firebaseConfig";
import { useAuthContext } from "../../contexts/AuthContext";
import Brand from "../layout/Brand";

export default function NoHotelAccessPage() {
  const { authLoading, authError, currentUser, isPlatformAdmin, hotelUids } =
    useAuthContext();
  if (authLoading)
    return (
      <p role="status" className="p-8">
        Checking access...
      </p>
    );
  if (!currentUser?.emailVerified) return <Navigate to="/login" replace />;
  if (isPlatformAdmin) return <Navigate to="/platform" replace />;
  if (hotelUids.length) return <Navigate to="/dashboard" replace />;
  return (
    <div className="min-h-screen bg-canvas">
      <header className="ht-public-header px-6 py-5">
        <Brand />
      </header>
      <main className="mx-auto max-w-xl px-5 py-16">
        <section className="ht-panel p-7 sm:p-9">
          <span className="inline-flex rounded-xl bg-brand-50 p-3 text-brand-800">
            <Building2 size={25} aria-hidden="true" />
          </span>
          <p className="ht-eyebrow mt-6">Account access</p>
          <h1 className="ht-page-title mt-3">
            {authError ? "Account access unavailable" : "No hotel assigned"}
          </h1>
          <p className="mt-5 text-sm leading-7 text-gray-600">
            {authError
              ? "Your account could not be checked. Sign in again to retry."
              : "Ask your hotel administrator to invite you. Hotel access is assigned to your named account."}
          </p>
          <button
            className="ht-button-secondary mt-7"
            onClick={() => signOut(auth)}
          >
            Sign out
          </button>
        </section>
      </main>
    </div>
  );
}
