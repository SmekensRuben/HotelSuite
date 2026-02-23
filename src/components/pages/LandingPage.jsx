// src/components/pages/LandingPage.jsx
import React from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";

export default function LandingPage() {
  const navigate = useNavigate();
  const { t } = useTranslation("landing");

  const features = [
    {
      icon: "/assets/sync_icon.png",
      alt: t("featureInventoryTitle"),
      title: t("featureInventoryTitle"),
      description: t("featureInventoryDesc"),
    },
    {
      icon: "/assets/analytics_icon.png",
      alt: t("featureOrderingTitle"),
      title: t("featureOrderingTitle"),
      description: t("featureOrderingDesc"),
    },
    {
      icon: "/assets/tablet_checkin.png",
      alt: t("featureApprovalsTitle"),
      title: t("featureApprovalsTitle"),
      description: t("featureApprovalsDesc"),
    },
    {
      icon: "/assets/analytics_icon.png",
      alt: t("featureOperaTitle"),
      title: t("featureOperaTitle"),
      description: t("featureOperaDesc"),
    },
    {
      icon: "/assets/sync_icon.png",
      alt: t("featureQuotesTitle"),
      title: t("featureQuotesTitle"),
      description: t("featureQuotesDesc"),
    },
    {
      icon: "/assets/tablet_checkin.png",
      alt: t("featureProcurementTitle"),
      title: t("featureProcurementTitle"),
      description: t("featureProcurementDesc"),
    },
  ];

  return (
    <div className="min-h-screen bg-white text-gray-900 font-sans">
      <header className="bg-[#b41f1f] text-white shadow-sm sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <img
              src="/assets/breakfast_pilot_logo_black_circle.png"
              alt="Hotel Toolkit Logo"
              className="h-10"
            />
            <h1 className="text-2xl font-bold tracking-wide">Hotel Toolkit</h1>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex gap-1">
              {["nl", "en", "fr"].map((lang) => (
                <button
                  key={lang}
                  onClick={() => {
                    i18n.changeLanguage(lang);
                    localStorage.setItem("lang", lang);
                  }}
                  className={`px-2 py-1 rounded text-sm ${
                    i18n.language === lang
                      ? "bg-white text-[#b41f1f] font-semibold"
                      : "text-white hover:underline"
                  }`}
                >
                  {lang.toUpperCase()}
                </button>
              ))}
            </div>
            <button
              onClick={() => navigate("/login")}
              className="bg-white text-[#b41f1f] px-4 py-2 rounded hover:bg-gray-100 text-sm font-semibold"
            >
              {t("login")}
            </button>
          </div>
        </div>
      </header>

      <main>
        <section className="bg-gray-50 py-20">
          <div className="max-w-4xl mx-auto px-6 text-center">
            <motion.h2
              className="text-4xl sm:text-5xl font-bold mb-4 leading-tight"
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
            >
              {t("heroTitle")}
            </motion.h2>
            <motion.p
              className="text-lg text-gray-700 mb-8"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.6, delay: 0.2 }}
            >
              {t("heroSubtitle")}
            </motion.p>
            <motion.button
              onClick={() => navigate("/login")}
              className="bg-[#b41f1f] text-white px-6 py-3 rounded-lg text-lg hover:bg-red-700 transition"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.6, delay: 0.4 }}
            >
              {t("cta")}
            </motion.button>
          </div>
        </section>

        <section className="py-20 bg-white">
          <div className="max-w-6xl mx-auto px-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-12 text-center">
            {features.map((feature, index) => (
              <motion.div
                key={feature.title}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: index * 0.08 }}
              >
                <img src={feature.icon} alt={feature.alt} className="h-20 mx-auto mb-4" />
                <h3 className="text-xl font-semibold mb-2">{feature.title}</h3>
                <p className="text-gray-600">{feature.description}</p>
              </motion.div>
            ))}
          </div>
        </section>

        <section className="text-center py-16 bg-gray-50">
          <h3 className="text-2xl font-semibold mb-4">{t("ctaFinalTitle")}</h3>
          <button
            onClick={() => navigate("/login")}
            className="bg-[#b41f1f] text-white px-6 py-3 rounded-lg hover:bg-red-700 transition"
          >
            {t("ctaFinalButton")}
          </button>
        </section>

        <footer className="bg-[#b41f1f] text-white py-6">
          <div className="max-w-6xl mx-auto px-6 flex flex-col sm:flex-row justify-between items-center text-sm">
            <p>&copy; {new Date().getFullYear()} Hotel Toolkit</p>
            <p className="mt-2 sm:mt-0">{t("footerMadeBy")}</p>
          </div>
        </footer>
      </main>
    </div>
  );
}
