import React from "react";

export default function PageContainer({
  children,
  className = "",
  as: Component = "main",
  ...props
}) {
  return (
    <Component
      id="page-content"
      tabIndex={-1}
      className={`ht-page-container ${className}`}
      {...props}
    >
      {children}
    </Component>
  );
}
