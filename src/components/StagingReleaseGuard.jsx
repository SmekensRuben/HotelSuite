import { useEffect, useState } from "react";
import { db, doc, onSnapshot } from "../firebaseConfig";
import { stagingReleaseState } from "../config/stagingRelease";

function StagingSession({ children }) {
  const sha = import.meta.env.VITE_RELEASE_SHA;
  const [state, setState] = useState("checking");
  useEffect(() => onSnapshot(doc(db, "_staging", "release"), { includeMetadataChanges: true }, (snapshot) => {
    setState(snapshot.metadata.fromCache ? "checking" : stagingReleaseState(snapshot.data(), sha));
  }, () => setState("unavailable")), [sha]);

  const banner = (
    <div role="status" className="relative z-50 bg-amber-200 px-4 py-2 text-center text-sm font-semibold text-amber-950">
      Staging · {sha?.slice(0, 12) || "Unknown version"} · Fictional data · Supplier deliveries and email are simulated
    </div>
  );
  if (state === "ready") return <>{banner}{children}</>;
  return <>{banner}<main className="mx-auto max-w-xl px-6 py-20 text-center">
    <h1 className="text-2xl font-semibold">Staging is not ready</h1>
    <p className="mt-4">{state === "version-mismatch"
      ? "This page belongs to a different release. Reload to use the verified version."
      : "Waiting for a verified frontend and backend from the same release. The deployment may still be in progress."}</p>
    <button type="button" className="mt-6 rounded bg-slate-900 px-5 py-2 text-white" onClick={() => window.location.reload()}>Reload staging</button>
  </main></>;
}

export default function StagingReleaseGuard({ children }) {
  return import.meta.env.VITE_DEPLOYMENT_ENV === "staging" ? <StagingSession>{children}</StagingSession> : children;
}
