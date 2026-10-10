import React, { useEffect, useState } from "react";
import { Dialog, DialogPanel, DialogTitle } from "@headlessui/react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { ChevronDown, Menu, X } from "lucide-react";
import Brand from "./Brand";

function WorkspaceLinks({ groups, label }) {
  return (
    <nav aria-label={label} className="p-4">
      {groups
        .filter((group) => group.items.length)
        .map((group) => (
          <details className="ht-nav-group" key={group.label} open>
            <summary>
              {group.label}
              <ChevronDown size={13} aria-hidden="true" />
            </summary>
            <div className="space-y-1">
              {group.items.map(({ to, label: itemLabel, icon: Icon, end }) => (
                <NavLink key={to} to={to} end={end} className="ht-nav-link">
                  <Icon size={17} aria-hidden="true" />
                  <span>{itemLabel}</span>
                </NavLink>
              ))}
            </div>
          </details>
        ))}
    </nav>
  );
}

export default function WorkspaceChrome({
  groups,
  actions,
  subtitle,
  footer,
  platform = false,
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const desktop = window.matchMedia("(min-width: 1024px)");
    const closeOnDesktop = () => {
      if (desktop.matches) setMobileOpen(false);
    };
    closeOnDesktop();
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);
  const label = platform ? "Platform navigation" : "Hotel navigation";
  return (
    <div className="ht-workspace-chrome">
      <a
        className="ht-skip-link"
        href={platform ? "#platform-content" : "#page-content"}
      >
        Skip to content
      </a>
      <header className="ht-topbar">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            className="ht-icon-button lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
            aria-expanded={mobileOpen}
          >
            <Menu size={20} />
          </button>
          <Link
            to={platform ? "/platform" : "/dashboard"}
            aria-label="Hotel Toolkit home"
          >
            <Brand className="text-lg sm:text-xl" />
          </Link>
          <span className="hidden border-l border-gray-200 pl-4 text-xs text-gray-500 xl:block">
            {subtitle}
          </span>
          {platform && (
            <span className="hidden rounded-full bg-gold-50 px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-gold-700 sm:inline-block">
              Platform
            </span>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          {actions}
        </div>
      </header>
      <aside className="ht-sidebar">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <WorkspaceLinks groups={groups} label={label} />
        </div>
        {footer && (
          <div className="border-t border-gray-200 p-5 text-xs leading-5 text-gray-500">
            {footer}
          </div>
        )}
      </aside>
      <Dialog
        open={mobileOpen}
        onClose={setMobileOpen}
        className="fixed inset-0 z-50 lg:hidden"
      >
        <div
          className="fixed inset-0 bg-brand-950/40 backdrop-blur-sm"
          aria-hidden="true"
        />
        <DialogPanel className="fixed inset-y-0 left-0 flex w-[min(320px,90vw)] flex-col bg-white shadow-lifted">
          <div className="flex items-center justify-between border-b border-gray-200 px-5 py-5">
            <DialogTitle>
              <Brand />
            </DialogTitle>
            <button
              type="button"
              className="ht-icon-button"
              onClick={() => setMobileOpen(false)}
              aria-label="Close navigation"
            >
              <X size={18} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <WorkspaceLinks groups={groups} label={label} />
          </div>
          {footer && (
            <div className="border-t border-gray-200 p-5 text-xs leading-5 text-gray-500">
              {footer}
            </div>
          )}
        </DialogPanel>
      </Dialog>
    </div>
  );
}
