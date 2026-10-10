import React from "react";

export default function Brand({ inverse = false, className = "" }) {
  return (
    <span
      className={`ht-brand ${inverse ? "text-white" : "text-brand-950"} ${className}`}
    >
      <svg
        viewBox="0 0 32 32"
        fill="none"
        aria-hidden="true"
        className={`ht-brand-mark ${inverse ? "!text-white" : ""}`}
      >
        <path d="M3 3h10v26H3zM17 11h10v18H17z" fill="currentColor" />
        <path d="M13 17h4v4h-4z" fill="currentColor" opacity=".45" />
      </svg>
      <span>Hotel Toolkit</span>
    </span>
  );
}
