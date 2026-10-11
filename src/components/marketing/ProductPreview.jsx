import React, { useState } from "react";
import {
  ArrowUpRight,
  Check,
  ClipboardList,
  FileText,
  Package,
  TrendingUp,
  Users,
} from "lucide-react";
import Brand from "../layout/Brand";

const examples = [
  {
    id: "procurement",
    label: "Purchasing",
    icon: Package,
    title: "Purchasing & Inventory",
    summary: "A clear overview of purchase orders and stock counts.",
    columns: ["Order", "Supplier", "Status"],
    rows: [
      ["PO-1042", "Sample supplier A", "Ordered"],
      ["PO-1041", "Sample supplier B", "Created"],
      ["PO-1040", "Sample supplier C", "Ordered"],
    ],
    notes: [
      "Catalog and supplier products",
      "Outlet approval workflows",
      "Stock counts by location",
    ],
  },
  {
    id: "contracts",
    label: "Contracts",
    icon: FileText,
    title: "Contract Management",
    summary: "Agreements and key dates, easy to find.",
    columns: ["Contract", "End date", "Status"],
    rows: [
      ["Lift maintenance", "31 Dec 2027", "Active"],
      ["Laundry agreement", "30 Jun 2027", "Active"],
      ["Equipment rental", "31 Mar 2027", "Review"],
    ],
    notes: ["Private attachments", "Cancellation dates", "Scheduled reminders"],
  },
  {
    id: "frontoffice",
    label: "Front Office",
    icon: ClipboardList,
    title: "Front Office & Upselling",
    summary: "Daily arrivals and upsell audits in one workspace.",
    columns: ["Audit", "Business date", "Status"],
    rows: [
      ["Room upgrade", "15 Oct 2026", "Approved"],
      ["Late checkout", "15 Oct 2026", "Pending"],
      ["Room upgrade", "15 Oct 2026", "Approved"],
    ],
    notes: [
      "Arrivals and reservations",
      "Upsell review workflows",
      "Team performance",
    ],
  },
  {
    id: "groups",
    label: "Groups",
    icon: Users,
    title: "Groups & Events",
    summary: "Coordinate room blocks and rooming-list updates.",
    columns: ["Group", "Rooms", "Rooming list"],
    rows: [
      ["Sample conference", "24", "Submitted"],
      ["Sample meeting", "12", "Not Started"],
      ["Sample delegation", "18", "Submitted"],
    ],
    notes: [
      "Room blocks and stay dates",
      "Shared rooming lists",
      "Versioned change requests",
    ],
  },
  {
    id: "revenue",
    label: "Revenue",
    icon: TrendingUp,
    title: "Revenue & Forecasting",
    summary: "Review group requests with forecast context.",
    columns: ["Request", "Room nights", "Status"],
    rows: [
      ["Sample conference", "48", "Draft"],
      ["Sample delegation", "36", "Draft"],
      ["Sample meeting", "24", "Draft"],
    ],
    notes: [
      "Contribution and opportunity cost",
      "Base scenario and sensitivity",
      "Forecast-dependent advice",
    ],
  },
];
export default function ProductPreview({ compact = false }) {
  const [active, setActive] = useState("procurement");
  const example = examples.find((item) => item.id === active);
  return (
    <div
      className="ht-panel min-w-0 overflow-hidden shadow-lifted"
      role="region"
      aria-label="Interactive product preview with fictional data"
    >
      <div className="flex items-center justify-between gap-3 border-b border-gray-200 bg-gray-50 px-4 py-4 sm:px-6">
        <Brand className="!text-base" />
        <span className="flex items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 px-2.5 py-1 text-[10px] font-semibold text-brand-800">
          <span className="ht-status-dot" />
          Demo data
        </span>
      </div>
      <div
        className="flex flex-wrap gap-1 border-b border-gray-200 px-3 py-3 sm:px-5"
        aria-label="Preview modules"
      >
        {examples.map(({ id, label, icon: Icon }) => (
          <button
            type="button"
            key={id}
            onClick={() => setActive(id)}
            aria-pressed={active === id}
            aria-controls="product-preview-content"
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-medium transition-colors ${active === id ? "bg-brand-800 text-white" : "text-gray-600 hover:bg-brand-50"}`}
          >
            <Icon size={14} aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>
      <div id="product-preview-content" className="p-4 sm:p-6">
        <p className="ht-eyebrow">Sample Hotel · Workspace preview</p>
        <h3 className="mt-2 text-xl font-semibold tracking-tight text-brand-950">
          {example.title}
        </h3>
        <p className="mt-2 text-xs leading-5 text-gray-600">
          {example.summary}
        </p>
        <div className="mt-5 overflow-x-auto rounded-xl border border-gray-200">
          <table className="ht-demo-table w-full min-w-[300px]">
            <caption className="sr-only">
              Fictional {example.title} records
            </caption>
            <thead className="bg-gray-50">
              <tr>
                {example.columns.map((label) => (
                  <th
                    key={label}
                    scope="col"
                    className="font-medium text-gray-500"
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {example.rows.map((row, rowIndex) => (
                <tr key={`${example.id}-${rowIndex}`}>
                  {row.map((cell, index) => (
                    <td
                      key={index}
                      className={
                        index === 0
                          ? "font-medium text-gray-800"
                          : "text-gray-600"
                      }
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className={`mt-5 grid gap-2 ${compact ? "" : "sm:grid-cols-3"}`}>
          {example.notes.map((note) => (
            <div
              key={note}
              className="flex items-start gap-2 rounded-lg bg-brand-50 px-3 py-3 text-xs leading-5 text-brand-800"
            >
              <Check size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              {note}
            </div>
          ))}
        </div>
        <p className="mt-4 flex items-start gap-2 text-[10px] leading-4 text-gray-500">
          <ArrowUpRight size={13} className="shrink-0" aria-hidden="true" />
          Illustrative records only. This preview does not access hotel data or
          calculate a quote.
        </p>
      </div>
    </div>
  );
}
