import React from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Building2,
  ClipboardList,
  FileText,
  Package,
  Settings2,
  TrendingUp,
  Users,
} from "lucide-react";
import PageShell from "../layout/PageShell";
import { useHotelContext } from "../../contexts/HotelContext";
import { usePermission } from "../../hooks/usePermission";

export default function DashboardPage() {
  const { hotelName, isHotelAdmin, isPlatformAdmin } = useHotelContext();
  const products = usePermission("catalogproducts", "read");
  const orders = usePermission("orders", "read");
  const stock = usePermission("stockcounts", "read");
  const contracts = usePermission("contracts", "read");
  const reservations = usePermission("reservations", "read");
  const upsells = usePermission("auditUpsells", "read");
  const auditSettings = usePermission("auditUpsells", "settings");
  const groups = usePermission("groups", "read");
  const quotes = usePermission("groupquotes", "read");
  const calendar = usePermission("demandcalendar", "read");
  const intelligence = usePermission("commercialintelligence", "read");
  const property = usePermission("propertysettings", "read");
  const cards = [
    {
      title: "Purchasing & Inventory",
      description:
        "Find products, manage orders and keep stock counts organized.",
      icon: Package,
      visible: products || orders || stock,
      to: products
        ? "/catalog/products"
        : orders
          ? "/orders"
          : "/catalog/stock-counts",
    },
    {
      title: "Contracts",
      description: "Keep agreements, attachments and key dates in one place.",
      icon: FileText,
      visible: contracts,
      to: "/contracts",
    },
    {
      title: "Front Office & Upselling",
      description: "Review daily reservation activity and upsell audits.",
      icon: ClipboardList,
      visible: reservations || upsells || auditSettings,
      to: reservations
        ? "/front-office/arrivals"
        : upsells
          ? "/front-office/upselling"
          : "/front-office/upselling/audit",
    },
    {
      title: "Groups & Events",
      description: "Coordinate room blocks, rooming lists and group updates.",
      icon: Users,
      visible: groups,
      to: "/me/groups",
    },
    {
      title: "Revenue & Forecasting",
      description:
        "Review group quotes, demand context and commercial insights.",
      icon: TrendingUp,
      visible: quotes || calendar || intelligence,
      to: quotes
        ? "/revenue/group-quotes"
        : calendar
          ? "/me/demand-calendar"
          : "/revenue/commercial-intelligence",
    },
  ].filter((card) => card.visible);
  return (
    <PageShell className="space-y-8">
      <section className="flex flex-wrap items-end justify-between gap-5 border-b border-gray-200 pb-7">
        <div>
          <p className="ht-eyebrow">Hotel workspace</p>
          <h1 className="ht-page-title mt-3">
            {hotelName || "Your hotel"}. Working together.
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-gray-600">
            Choose a workflow to get started. Your workspace shows the tools
            available to your account.
          </p>
        </div>
        <span className="flex flex-wrap items-center gap-2 rounded-full border border-gray-200 bg-white px-4 py-2 text-xs font-medium text-gray-600">
          <Building2 size={15} aria-hidden="true" />
          Overview
        </span>
      </section>
      {cards.length ? (
        <section
          aria-label="Available hotel workflows"
          className="grid gap-5 md:grid-cols-2 xl:grid-cols-3"
        >
          {cards.map(({ title, description, to, icon: Icon }) => (
            <Link
              key={title}
              to={to}
              className="ht-panel group flex flex-col p-6 transition-colors hover:border-brand-300"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-brand-100 bg-brand-50 text-brand-800">
                <Icon size={23} strokeWidth={1.5} aria-hidden="true" />
              </span>
              <h2 className="mt-5 font-display text-2xl text-brand-950">
                {title}
              </h2>
              <p className="mt-3 flex-1 text-sm leading-6 text-gray-600">
                {description}
              </p>
              <span className="mt-7 flex flex-wrap items-center justify-between border-t border-gray-200 pt-4 text-xs font-semibold text-brand-700">
                Open workflow
                <ArrowRight size={16} aria-hidden="true" />
              </span>
            </Link>
          ))}
        </section>
      ) : (
        <section className="ht-panel p-6">
          <h2 className="text-lg font-semibold">
            Your workspace is ready for access setup
          </h2>
          <p className="mt-3 text-sm leading-6 text-gray-600">
            Ask your hotel administrator to assign the module permissions you
            need for your work.
          </p>
        </section>
      )}
      {(isHotelAdmin || property || isPlatformAdmin) && (
        <section className="ht-panel flex flex-wrap items-center justify-between gap-5 p-6">
          <div>
            <p className="ht-eyebrow">Administration</p>
            <h2 className="mt-2 font-display text-2xl text-brand-950">
              Keep your workspace organized.
            </h2>
          </div>
          <div className="flex flex-wrap gap-3">
            {isHotelAdmin && (
              <Link to="/settings/team" className="ht-button-secondary">
                <Users size={16} aria-hidden="true" />
                Hotel team
              </Link>
            )}
            {property && (
              <Link to="/settings/property" className="ht-button-secondary">
                <Settings2 size={16} aria-hidden="true" />
                Property settings
              </Link>
            )}
            {isPlatformAdmin && (
              <Link to="/platform" className="ht-button-secondary">
                Platform console
                <ArrowRight size={16} aria-hidden="true" />
              </Link>
            )}
          </div>
        </section>
      )}
    </PageShell>
  );
}
