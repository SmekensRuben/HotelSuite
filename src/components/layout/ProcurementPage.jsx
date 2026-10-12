import React from "react";
import PageContainer from "./PageContainer";
import { cn } from "../../lib/utils";

/** Keep the sidebar's reserved workspace separate from readable content width. */
export default function ProcurementPage({ children, className = "", width = "workspace", ...props }) {
  return <PageContainer className="ht-procurement-page" {...props}>
    <div data-procurement-content className={cn("mx-auto w-full min-w-0 [overflow-wrap:anywhere] [&_table]:[overflow-wrap:normal] [&_button]:[overflow-wrap:normal]", width === "form" ? "max-w-3xl" : "max-w-6xl", className)}>{children}</div>
  </PageContainer>;
}
