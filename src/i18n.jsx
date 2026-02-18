import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import landingNL from "./locales/nl/landing.json";
import landingEN from "./locales/en/landing.json";
import landingFR from "./locales/fr/landing.json";

import authNL from "./locales/nl/auth.json";
import authEN from "./locales/en/auth.json";
import authFR from "./locales/fr/auth.json";

import dashboardNL from "./locales/nl/dashboard.json";
import dashboardEN from "./locales/en/dashboard.json";
import dashboardFR from "./locales/fr/dashboard.json";

import reservationsNL from "./locales/nl/reservations.json";
import reservationsEN from "./locales/en/reservations.json";
import reservationsFR from "./locales/fr/reservations.json";

import calendarNL from "./locales/nl/calendar.json";
import calendarEN from "./locales/en/calendar.json";
import calendarFR from "./locales/fr/calendar.json";

import commonNL from "./locales/nl/common.json";
import commonEN from "./locales/en/common.json";
import commonFR from "./locales/fr/common.json";

const resources = {
  nl: {
    landing: landingNL,
    auth: authNL,
    dashboard: dashboardNL,
    reservations: reservationsNL,
    calendar: calendarNL,
    common: commonNL,
  },
  en: {
    landing: landingEN,
    auth: authEN,
    dashboard: dashboardEN,
    reservations: reservationsEN,
    calendar: calendarEN,
    common: commonEN,
  },
  fr: {
    landing: landingFR,
    auth: authFR,
    dashboard: dashboardFR,
    reservations: reservationsFR,
    calendar: calendarFR,
    common: commonFR,
  },
};

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: localStorage.getItem("lang") || "nl",
    fallbackLng: "nl",
    ns: ["common", "auth", "landing", "dashboard", "reservations", "calendar"],
    defaultNS: "common",
    interpolation: {
      escapeValue: false
    }
  });

export default i18n;
