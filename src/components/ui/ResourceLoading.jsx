import React from "react";

export function LoadingStatus({ children = "Loading…", className = "" }) {
  return <p role="status" aria-live="polite" className={`flex items-center gap-2 text-sm text-gray-500 ${className}`}>
    <span aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-gray-200 border-t-brand-700 motion-reduce:animate-none" />
    {children}
  </p>;
}

/** One announced status; visual placeholders do not become fictitious article names. */
export function ArticleRowsSkeleton({ rows = 4, label = "Preparing included articles…" }) {
  return <div aria-busy="true" className="space-y-4">
    <LoadingStatus>{label}</LoadingStatus>
    <div aria-hidden="true" className="divide-y divide-gray-100">
      {Array.from({ length: rows }, (_, index) => <div key={index} className="flex items-center justify-between gap-5 py-3">
        <div className="min-w-0 flex-1 space-y-2 animate-pulse motion-reduce:animate-none">
          <div className="h-3.5 w-3/5 rounded bg-gray-100" />
          <div className="h-2.5 w-2/5 rounded bg-gray-100" />
        </div>
        <div className="h-7 w-20 rounded bg-gray-100 animate-pulse motion-reduce:animate-none" />
      </div>)}
    </div>
  </div>;
}
