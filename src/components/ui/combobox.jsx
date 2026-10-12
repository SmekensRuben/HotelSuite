import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getSearchTokens, matchesSearchTokens } from "../../utils/search";
import { cn } from "../../lib/utils";

/** Typing and leaving this selection field never commits a choice. */
export function Combobox({ value, onChange, options = [], displayValue, getOptionValue,
  placeholder = "Search and select", disabled = false, required = false, id, name, className,
  loading = false, emptyMessage = "No matching options.", description, allowClear = false,
  onQueryChange, filterOptions = true, maxVisibleOptions = 80, "aria-label": ariaLabel,
  "aria-describedby": describedBy }) {
  const generatedId = useId(), inputId = id || "combobox-" + generatedId, listId = inputId + "-options";
  const [query, setQuery] = useState(""), [isOpen, setIsOpen] = useState(false), [activeIndex, setActiveIndex] = useState(-1);
  const [touched, setTouched] = useState(false);
  const [menuPosition, setMenuPosition] = useState(null);
  const wrapper = useRef(null), input = useRef(null), menu = useRef(null);
  const selected = value !== null && value !== undefined;
  const filtered = useMemo(() => {
    const entries = Array.isArray(options) ? options : [], tokens = getSearchTokens(query);
    return !filterOptions || !tokens.length ? entries : entries.filter((option) => matchesSearchTokens(displayValue(option), tokens));
  }, [options, query, displayValue, filterOptions]);
  const visible = filtered.slice(0, Math.max(1, Math.min(500, maxVisibleOptions)));
  const descriptionId = description ? inputId + "-description" : undefined;
  const close = () => { setIsOpen(false); setQuery(""); setActiveIndex(-1); };
  const choose = (option) => { if (disabled) return; onChange(option); setTouched(true); close(); };
  useEffect(() => { input.current?.setCustomValidity(required && !selected && !disabled ? "Choose an option from the list." : ""); }, [required, selected, disabled]);
  useEffect(() => {
    if (!isOpen) return;
    const outside = (event) => { if (!wrapper.current?.contains(event.target) && !menu.current?.contains(event.target)) close(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [isOpen]);
  useEffect(() => {
    if (isOpen && activeIndex >= 0) document.getElementById(listId + "-" + activeIndex)?.scrollIntoView?.({ block: "nearest" });
  }, [isOpen, activeIndex, listId]);
  const active = activeIndex >= 0 && activeIndex < visible.length ? activeIndex : -1;
  const expanded = isOpen && !disabled;
  useLayoutEffect(() => {
    if (!expanded || !input.current) return;
    const position = () => {
      const box = input.current.getBoundingClientRect(), viewport = window.innerHeight;
      const width = Math.min(box.width || 240, window.innerWidth - 16);
      const above = viewport - box.bottom < 160 && box.top > viewport - box.bottom;
      setMenuPosition({ left: Math.max(8, Math.min(box.left, window.innerWidth - width - 8)), width,
        ...(above ? { bottom: viewport - box.top + 4 } : { top: box.bottom + 4 }),
        maxHeight: Math.min(256, Math.max(80, above ? box.top - 12 : viewport - box.bottom - 12)) });
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [expanded, query, filtered.length, loading, value]);
  return <div ref={wrapper} className="min-w-0">
    <div className="relative">
      <input ref={input} id={inputId} name={name} type="text" role="combobox" autoComplete="off"
        aria-label={ariaLabel} aria-expanded={expanded} aria-haspopup="listbox" aria-controls={listId}
        aria-autocomplete="list" aria-activedescendant={expanded && active >= 0 ? listId + "-" + active : undefined}
        aria-describedby={[describedBy, descriptionId].filter(Boolean).join(" ") || undefined}
        aria-invalid={required && touched && !selected ? true : undefined} aria-busy={loading || undefined}
        className={cn("w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2.5 pr-9 text-sm outline-none focus:border-brand-700 focus:ring-2 focus:ring-brand-100 disabled:bg-gray-50 disabled:text-gray-500", className)}
        placeholder={placeholder} value={expanded ? query : selected ? displayValue(value) : ""}
        disabled={disabled} required={required}
        onChange={(event) => { setQuery(event.target.value); setIsOpen(true); setActiveIndex(0); onQueryChange?.(event.target.value); }}
        onFocus={() => { setIsOpen(true); setQuery(""); setActiveIndex(-1); onQueryChange?.(""); }}
        onClick={() => { if (!expanded) { setIsOpen(true); setQuery(""); setActiveIndex(-1); onQueryChange?.(""); } }}
        onBlur={(event) => { if (!wrapper.current?.contains(event.relatedTarget) && !menu.current?.contains(event.relatedTarget)) { setTouched(true); close(); } }}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); close(); }
          else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault(); setIsOpen(true);
            setActiveIndex(visible.length ? (event.key === "ArrowDown" ? (active + 1) % visible.length : (active < 0 ? visible.length - 1 : (active - 1 + visible.length) % visible.length)) : -1);
          } else if (expanded && (event.key === "Home" || event.key === "End")) {
            event.preventDefault(); setActiveIndex(visible.length ? event.key === "Home" ? 0 : visible.length - 1 : -1);
          } else if (expanded && event.key === "Enter") {
            event.preventDefault(); if (!loading && active >= 0) choose(visible[active]);
          } else if (event.key === "Tab") close();
        }} />
      {allowClear && selected && !disabled ? <button type="button" aria-label="Clear selection" className="absolute inset-y-0 right-1 px-2 text-gray-500 hover:text-gray-900"
        onMouseDown={(event) => event.preventDefault()} onClick={() => { onChange(null); setQuery(""); setActiveIndex(-1); setIsOpen(true); onQueryChange?.(""); input.current?.focus(); }}>×</button>
        : <span aria-hidden="true" className="pointer-events-none absolute right-3 top-2.5 text-gray-400">⌄</span>}
      {expanded && menuPosition && createPortal(<ul ref={menu} id={listId} role="listbox" aria-label={ariaLabel || "Options"}
        style={menuPosition} className="fixed z-[70] overflow-y-auto whitespace-normal rounded-lg border border-gray-200 bg-white p-1 shadow-lg [overflow-wrap:anywhere]">
        {loading && <li role="presentation" className="px-3 py-2 text-sm text-gray-500"><span role="status">Loading options...</span></li>}
        {!loading && !visible.length && <li role="presentation" className="px-3 py-2 text-sm text-gray-500"><span role="status">{emptyMessage}</span></li>}
        {!loading && visible.map((option, index) => <li key={getOptionValue(option)} id={listId + "-" + index} role="option"
          aria-selected={selected && getOptionValue(value) === getOptionValue(option)}
          className={cn("cursor-pointer rounded-md px-3 py-2 text-sm", active === index ? "bg-brand-50 text-brand-950" : "hover:bg-gray-50")}
          onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActiveIndex(index)} onClick={() => choose(option)}>{displayValue(option)}</li>)}
        {!loading && filtered.length > visible.length && <li role="presentation" className="border-t px-3 py-2 text-xs text-gray-500">Showing {visible.length} of {filtered.length} matches. Refine your search to find more.</li>}
      </ul>, document.body)}
    </div>
    {description && <p id={descriptionId} className="mt-1.5 text-xs text-gray-500">{description}</p>}
  </div>;
}
