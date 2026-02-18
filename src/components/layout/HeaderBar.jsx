import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useHotelContext } from "contexts/HotelContext";
import { db, doc, getDoc } from "../../firebaseConfig";
import { Package, Settings2 } from "lucide-react";

export default function HeaderBar({ today, onLogout }) {
  const navigate = useNavigate();
  const { t } = useTranslation(["common", "reservations"]);
  const { hotelUid, hotelUids = [], selectHotel } = useHotelContext();
  const [hotels, setHotels] = useState([]);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isCatalogOpen, setIsCatalogOpen] = useState(false);
  const settingsMenuRef = useRef(null);
  const catalogMenuRef = useRef(null);

  const settingsMenuItems = [
    {
      label: "General Settings",
      action: () => navigate("/settings/general"),
      icon: Settings2,
    },
  ];

  const catalogMenuItems = [
    {
      label: "Products",
      action: () => navigate("/catalog/products"),
      icon: Package,
    },
  ];

  useEffect(() => {
    async function fetchHotels() {
      const results = await Promise.all(
        hotelUids.map(async (uid) => {
          try {
            const snap = await getDoc(doc(db, `hotels/${uid}/settings`, uid));
            const data = snap.exists() ? snap.data() : {};
            return { uid, name: data.hotelName || uid };
          } catch {
            return { uid, name: uid };
          }
        })
      );
      setHotels(results);
    }
    if (hotelUids.length) {
      fetchHotels();
    }
  }, [hotelUids]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (settingsMenuRef.current && !settingsMenuRef.current.contains(event.target)) {
        setIsSettingsOpen(false);
      }
      if (catalogMenuRef.current && !catalogMenuRef.current.contains(event.target)) {
        setIsCatalogOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <header className="bg-[#b41f1f] text-white shadow sticky top-0 z-20 px-2 py-2 mb-4">
      <div className="max-w-6xl mx-auto flex flex-col gap-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div
            className="flex flex-row items-center justify-center sm:justify-start gap-2 sm:gap-4 w-full sm:w-auto cursor-pointer"
            onClick={() => navigate("/dashboard")}
          >
            <img
              src="/assets/breakfast_pilot_logo_black_circle.png"
              alt="Revenue Pilot Logo"
              className="h-10 sm:h-16"
            />
            <h1 className="text-lg sm:text-2xl font-bold tracking-wide text-center flex-1">
              Revenue Pilot
            </h1>
          </div>

          <div className="flex flex-col sm:flex-row items-end sm:items-center w-full sm:w-auto gap-2 sm:gap-3">
            <div className="flex flex-row sm:flex-col gap-2 sm:gap-0 sm:mr-4 text-sm sm:text-base text-right w-full sm:w-auto">
              <select
                value={hotelUid || ""}
                onChange={(e) => selectHotel && selectHotel(e.target.value)}
                className="bg-white text-[#b41f1f] px-2 py-1 rounded font-semibold"
              >
                {hotels.map((hotel) => (
                  <option key={hotel.uid} value={hotel.uid}>
                    {hotel.name}
                  </option>
                ))}
              </select>
              <div className="text-white text-opacity-80">{today}</div>
            </div>
            <div className="flex flex-row gap-2 w-full sm:w-auto">
              <button
                onClick={() => navigate("/dashboard")}
                className="bg-white text-[#b41f1f] px-3 py-2 rounded font-semibold w-1/2 sm:w-auto hover:bg-gray-100 text-sm"
                style={{ minHeight: 44 }}
              >
                ← {t("backToDashboard")}
              </button>
              <button
                onClick={onLogout}
                className="bg-white text-[#b41f1f] px-3 py-2 rounded font-semibold w-1/2 sm:w-auto hover:bg-gray-100 text-sm"
                style={{ minHeight: 44 }}
              >
                {t("logout")}
              </button>
            </div>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <div ref={catalogMenuRef} className="flex justify-end w-full sm:w-auto">
            <div className="relative w-full sm:w-auto">
              <button
                onClick={() => {
                  setIsCatalogOpen((prev) => !prev);
                  setIsSettingsOpen(false);
                }}
                className="bg-transparent text-white px-4 py-2 rounded font-semibold w-full sm:w-auto text-sm flex items-center justify-between shadow-sm"
                style={{ minHeight: 44 }}
              >
                <span className="uppercase tracking-wide">Catalog</span>
                <span className="ml-3 text-base">▾</span>
              </button>
              {isCatalogOpen && (
                <div className="absolute left-0 mt-2 w-64 rounded-lg shadow-xl ring-1 ring-black/5 z-30 overflow-hidden bg-white text-gray-900">
                  <div className="py-2">
                    {catalogMenuItems.map((item) => {
                      const Icon = item.icon;
                      return (
                        <button
                          key={item.label}
                          onClick={() => {
                            item.action();
                            setIsCatalogOpen(false);
                          }}
                          className="w-full px-4 py-2 flex items-center gap-3 hover:bg-gray-100 transition-colors text-left"
                        >
                          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-100">
                            {Icon && <Icon className="h-4 w-4" />}
                          </span>
                          <span className="text-sm font-semibold">{item.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div ref={settingsMenuRef} className="flex justify-end w-full sm:w-auto">
            <div className="relative w-full sm:w-auto">
              <button
                onClick={() => {
                  setIsSettingsOpen((prev) => !prev);
                  setIsCatalogOpen(false);
                }}
                className="bg-transparent text-white px-4 py-2 rounded font-semibold w-full sm:w-auto text-sm flex items-center justify-between shadow-sm"
                style={{ minHeight: 44 }}
              >
                <div className="flex items-center gap-2">
                  <span className="uppercase tracking-wide">Settings</span>
                </div>
                <span className="ml-3 text-base">▾</span>
              </button>
              {isSettingsOpen && (
                <div className="absolute left-0 mt-2 w-64 rounded-lg shadow-xl ring-1 ring-black/5 z-30 overflow-hidden bg-white text-gray-900">
                  <div className="py-2">
                    {settingsMenuItems.map((item) => {
                      const Icon = item.icon;
                      return (
                        <button
                          key={item.label}
                          onClick={() => {
                            item.action();
                            setIsSettingsOpen(false);
                          }}
                          className="w-full px-4 py-2 flex items-center gap-3 hover:bg-gray-100 transition-colors text-left"
                        >
                          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-100">
                            {Icon && <Icon className="h-4 w-4" />}
                          </span>
                          <span className="text-sm font-semibold">{item.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
