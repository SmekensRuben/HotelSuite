import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

export default function HistoricalYearsDropdown({ years, selectedYears, onToggle }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    const closeOnOutsideClick = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, []);

  const label = selectedYears.length === years.length && years.length
    ? `All years (${years.length})`
    : `${selectedYears.length} year${selectedYears.length === 1 ? "" : "s"} selected`;

  return <div ref={containerRef} className="relative max-w-sm">
    <button type="button" onClick={() => setOpen((current) => !current)} aria-haspopup="listbox" aria-expanded={open} className="flex w-full items-center justify-between rounded-lg border border-gray-300 bg-white px-3 py-2 text-left text-sm">
      <span>{years.length ? label : "No historical years available"}</span><ChevronDown className="h-4 w-4 text-gray-500" />
    </button>
    {open && years.length > 0 && <div role="listbox" aria-multiselectable="true" className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-gray-200 bg-white py-1 shadow-xl">
      {years.map((year) => {
        const checked = selectedYears.includes(year);
        return <button key={year} type="button" role="option" aria-selected={checked} onClick={() => onToggle(year)} className="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-gray-50">
          <span>{year}</span><span className={`flex h-5 w-5 items-center justify-center rounded border ${checked ? "border-[#b41f1f] bg-[#b41f1f] text-white" : "border-gray-300"}`}>{checked && <Check className="h-3.5 w-3.5" />}</span>
        </button>;
      })}
    </div>}
  </div>;
}
