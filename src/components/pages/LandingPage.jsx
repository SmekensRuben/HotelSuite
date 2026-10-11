import React from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  ArrowUpRight,
  Building2,
  Check,
  ClipboardList,
  FileText,
  Package,
  TrendingUp,
  Users,
} from "lucide-react";
import Brand from "../layout/Brand";
import ProductPreview from "../marketing/ProductPreview";
import { MARKETING_MODULES } from "../../constants/marketingModules";
import { publicDemoLink } from "../../utils/publicDemoLink";

const icons = {
  procurement: Package,
  contracts: FileText,
  frontoffice: ClipboardList,
  groups: Users,
  revenue: TrendingUp,
};
export default function LandingPage() {
  const { t } = useTranslation("landing");
  const copy = (key) => t(`redesign.${key}`, { lng: "en" });
  const demo = publicDemoLink({
    url: import.meta.env.VITE_PUBLIC_DEMO_URL,
    email: import.meta.env.VITE_PUBLIC_CONTACT_EMAIL,
  });
  const demoAction = (
    <a href={demo || "#preview"} className="ht-button-gold">
      {demo ? copy("bookDemo") : copy("viewPreview")}
      <ArrowRight size={16} aria-hidden="true" />
    </a>
  );
  return (
    <div className="min-h-screen bg-canvas text-gray-900">
      <a href="#landing-content" className="ht-skip-link">
        Skip to content
      </a>
      <header className="ht-public-header">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-5 py-5 sm:px-8 lg:px-10">
          <Link to="/" aria-label="Hotel Toolkit home">
            <Brand />
          </Link>
          <nav
            aria-label="Main navigation"
            className="order-3 flex w-full items-center justify-center gap-6 text-xs font-medium text-gray-700 md:order-none md:w-auto"
          >
            <a className="hover:text-brand-800" href="#modules">
              {copy("modules")}
            </a>
            <a className="hover:text-brand-800" href="#how-it-works">
              {copy("howItWorks")}
            </a>
            <a className="hover:text-brand-800" href="#pricing">
              {copy("pricing")}
            </a>
          </nav>
          <div className="flex flex-wrap items-center gap-3">
            <Link to="/login" className="text-xs font-semibold text-gray-700">
              {copy("logIn")}
            </Link>
            <span className="hidden sm:block">{demoAction}</span>
          </div>
        </div>
      </header>
      <main id="landing-content" tabIndex={-1}>
        <section className="ht-landing-section grid items-center gap-12 pb-12 lg:grid-cols-[.9fr_1.1fr] lg:gap-12 lg:py-24">
          <div>
            <p className="ht-eyebrow">{copy("eyebrow")}</p>
            <h1 className="ht-landing-title mt-6">
              {copy("heroFirst")}
              <br />
              {copy("heroSecond")}
            </h1>
            <p className="mt-7 max-w-md text-base leading-7 text-gray-600 sm:text-lg">
              {copy("heroDescription")}
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a href="#modules" className="ht-button-primary !px-5 !py-3">
                {copy("exploreModules")}
                <ArrowRight size={16} aria-hidden="true" />
              </a>
              {demoAction}
            </div>
            <p className="mt-6 flex flex-wrap items-center gap-2 text-xs text-gray-500">
              <Building2 size={15} aria-hidden="true" />
              {copy("heroNote")}
            </p>
          </div>
          <div id="preview" className="min-w-0 scroll-mt-6">
            <ProductPreview compact />
          </div>
        </section>
        <div className="border-y border-gray-200 bg-white/50">
          <div className="mx-auto grid max-w-7xl gap-5 px-5 py-6 text-sm text-gray-600 sm:grid-cols-3 sm:px-8 lg:px-10">
            {["benefitOne", "benefitTwo", "benefitThree"].map((key) => (
              <p key={key} className="flex flex-wrap items-center gap-3">
                <Check
                  size={16}
                  className="text-brand-700"
                  aria-hidden="true"
                />
                {copy(key)}
              </p>
            ))}
          </div>
        </div>
        <section id="modules" className="ht-landing-section scroll-mt-6">
          <div className="mb-9 flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
            <div>
              <p className="ht-eyebrow">{copy("moduleEyebrow")}</p>
              <h2 className="mt-4 max-w-xl font-display text-4xl leading-tight tracking-tight text-brand-950 sm:text-5xl">
                {copy("moduleTitle")}
              </h2>
            </div>
            <p className="max-w-sm text-sm leading-6 text-gray-600">
              {copy("moduleDescription")}
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            {MARKETING_MODULES.map((module) => {
              const Icon = icons[module.id];
              return (
                <article
                  key={module.id}
                  className="ht-panel flex flex-col p-5 transition-colors hover:border-brand-300"
                >
                  <Icon
                    size={25}
                    strokeWidth={1.5}
                    className="text-brand-800"
                    aria-hidden="true"
                  />
                  <h3 className="mt-5 min-h-12 font-display text-xl leading-6 text-brand-950">
                    {module.label}
                  </h3>
                  <p className="mt-3 text-sm leading-6 text-gray-600">
                    {module.description}
                  </p>
                  <ul className="mt-5 space-y-3 border-t border-gray-200 pt-5">
                    {module.features.map((feature) => (
                      <li
                        key={feature}
                        className="flex items-start gap-2 text-xs leading-5 text-gray-600"
                      >
                        <Check
                          size={13}
                          className="mt-1 shrink-0 text-brand-600"
                          aria-hidden="true"
                        />
                        {feature}
                      </li>
                    ))}
                  </ul>
                </article>
              );
            })}
          </div>
        </section>
        <section
          id="how-it-works"
          className="border-y border-gray-200 bg-white/50"
        >
          <div className="ht-landing-section grid gap-10 lg:grid-cols-[.8fr_1.2fr]">
            <div>
              <p className="ht-eyebrow">{copy("gettingStarted")}</p>
              <h2 className="mt-4 font-display text-4xl tracking-tight text-brand-950">
                {copy("startTitle")}
              </h2>
              <p className="mt-5 max-w-sm text-sm leading-7 text-gray-600">
                {copy("startDescription")}
              </p>
            </div>
            <ol className="grid gap-6 sm:grid-cols-3">
              {[1, 2, 3].map((step) => (
                <li key={step}>
                  <span className="flex h-10 w-10 items-center justify-center rounded-full border border-gold-300 bg-gold-50 font-display text-lg text-gold-700">
                    0{step}
                  </span>
                  <h3 className="mt-5 font-semibold text-brand-950">
                    {copy(`step${step}Title`)}
                  </h3>
                  <p className="mt-3 text-sm leading-6 text-gray-600">
                    {copy(`step${step}Description`)}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </section>
        <section id="pricing" className="ht-landing-section scroll-mt-6">
          <div className="ht-panel grid gap-8 p-6 sm:p-10 lg:grid-cols-[1.1fr_.9fr]">
            <div>
              <p className="ht-eyebrow">{copy("pricing")}</p>
              <h2 className="mt-4 font-display text-4xl tracking-tight text-brand-950">
                {copy("pricingTitle")}
              </h2>
              <p className="mt-5 max-w-lg text-sm leading-7 text-gray-600">
                {copy("pricingDescription")}
              </p>
              <a
                href={demo || "#how-it-works"}
                className="ht-button-primary mt-7"
              >
                {demo ? copy("requestProposal") : copy("planSetup")}
                <ArrowUpRight size={16} aria-hidden="true" />
              </a>
            </div>
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-6">
              <p className="text-sm font-semibold text-brand-950">
                {copy("includedTitle")}
              </p>
              <ul className="mt-4 space-y-4">
                {[
                  "includedOne",
                  "includedTwo",
                  "includedThree",
                  "includedFour",
                ].map((key) => (
                  <li
                    key={key}
                    className="flex items-start gap-3 text-sm leading-6 text-gray-600"
                  >
                    <Check
                      size={15}
                      className="mt-1 shrink-0 text-brand-700"
                      aria-hidden="true"
                    />
                    {copy(key)}
                  </li>
                ))}
              </ul>
              <p className="mt-5 border-t border-gray-200 pt-4 text-xs leading-5 text-gray-500">
                {copy("pricingNote")}
              </p>
            </div>
          </div>
        </section>
        <section className="bg-brand-900 text-white">
          <div className="ht-landing-section flex flex-col justify-between gap-8 py-12 md:flex-row md:items-center">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[.2em] text-brand-200">
                {copy("closingEyebrow")}
              </p>
              <h2 className="mt-4 max-w-xl font-display text-3xl leading-tight sm:text-4xl">
                {copy("closingTitle")}
              </h2>
            </div>
            {demoAction}
          </div>
        </section>
      </main>
      <footer className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-5 py-8 text-xs text-gray-500 sm:px-8 lg:px-10">
        <Brand className="!text-lg" />
        <p>© {new Date().getFullYear()} Hotel Toolkit</p>
        <Link to="/login" className="font-medium text-gray-700">
          {copy("logIn")}
        </Link>
      </footer>
    </div>
  );
}
