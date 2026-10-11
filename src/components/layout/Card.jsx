import React from "react";

export function Card({ children, className = "", ...props }) {
  return (
    <div className={`ht-panel p-5 sm:p-6 ${className}`} {...props}>
      {children}
    </div>
  );
}
