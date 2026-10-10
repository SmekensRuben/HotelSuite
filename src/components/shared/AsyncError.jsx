import React from "react";

export default function AsyncError({ error, onRetry, label = "Could not load this data." }) {
  if (!error) return null;
  return <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">
    <p className="font-semibold">{label}</p><p className="mt-1 text-sm">{error.message || "Please try again."}</p>
    {onRetry && <button type="button" onClick={onRetry} className="mt-3 rounded border border-red-300 bg-white px-3 py-1 font-semibold">Retry</button>}
  </div>;
}
