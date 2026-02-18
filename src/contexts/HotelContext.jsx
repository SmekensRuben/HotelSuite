import React, { createContext, useContext, useEffect, useState } from "react";
import { auth, db, doc, getDoc } from "../firebaseConfig";
import i18n from "../i18n";
import {
  getSelectedHotelUid,
  setSelectedHotelUid as persistSelectedHotelUid,
} from "utils/hotelUtils";

const HotelContext = createContext();

const normalizeLanguage = (value) => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (normalized.startsWith("en") || normalized === "english" || normalized === "engels") {
    return "en";
  }

  if (normalized.startsWith("fr") || normalized === "french" || normalized === "frans") {
    return "fr";
  }

  if (normalized.startsWith("nl") || normalized === "dutch" || normalized === "nederlands") {
    return "nl";
  }

  return null;
};

export function HotelProvider({ children }) {
  const [hotelName, setHotelName] = useState("Hotel");
  const [language, setLanguage] = useState(localStorage.getItem("lang") || "nl");
  const [hotelUids, setHotelUids] = useState([]);
  const [selectedHotelUid, setSelectedHotelUid] = useState(
    getSelectedHotelUid() || null
  );
  const [loading, setLoading] = useState(true);
  const [roles, setRoles] = useState([]);
  const [userData, setUserData] = useState(null);
  const [lightspeedShiftRolloverHour, setLightspeedShiftRolloverHour] = useState(4);
  const [posProvider, setPosProvider] = useState("lightspeed");
  const [orderMode, setOrderMode] = useState("ingredient");

  useEffect(() => {
    if (language) {
      i18n.changeLanguage(language);
      localStorage.setItem("lang", language);
    }
  }, [language]);

  const loadHotelSettings = async (uid, data) => {
    if (!uid) return;
    try {
      const settingsRef = doc(db, `hotels/${uid}/settings`, uid);
      const settingsSnap = await getDoc(settingsRef);
      const settings = settingsSnap.exists() ? settingsSnap.data() : {};

      setHotelName(settings.hotelName || "Hotel");
      const preferredLanguage =
        normalizeLanguage(data?.language) || normalizeLanguage(settings.language) || "nl";
      setLanguage(preferredLanguage);
      const rolloverSetting = Number(settings.lightspeedShiftRolloverHour);
      setLightspeedShiftRolloverHour(
        Number.isFinite(rolloverSetting) ? rolloverSetting : 4
      );
      setPosProvider(settings.posProvider || "lightspeed");
      setOrderMode(settings.orderMode || "ingredient");

      const userRoles = data?.roles?.[uid] || data?.roles || [];
      setRoles(Array.isArray(userRoles) ? userRoles : []);
    } catch (err) {
      console.error("Fout bij laden van hotelinstellingen:", err);
      setHotelName("Hotel");
      setLanguage("nl");
      setLightspeedShiftRolloverHour(4);
      setRoles([]);
    }
  };

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged(async (user) => {
      if (!user?.uid) {
        setRoles([]);
        setHotelUids([]);
        setUserData(null);
        persistSelectedHotelUid(null);
        setLoading(false);
        return;
      }

      try {
        const userRef = doc(db, "users", user.uid);
        const userSnap = await getDoc(userRef);

        if (!userSnap.exists()) {
          console.error("Gebruikersprofiel niet gevonden in database.");
          setRoles([]);
          setLoading(false);
          return;
        }

        const data = userSnap.data();
        setUserData(data);

        let hotels = data?.hotelUids || data?.hotelUid || [];
        hotels = Array.isArray(hotels) ? hotels : [hotels].filter(Boolean);
        if (!hotels.length) {
          console.error("hotelUids ontbreken in gebruikersprofiel.");
          setRoles([]);
          setLoading(false);
          return;
        }

        setHotelUids(hotels);

        let uid = getSelectedHotelUid();
        if (!uid || !hotels.includes(uid)) {
          uid = hotels[0];
          persistSelectedHotelUid(uid);
        }

        setSelectedHotelUid(uid);
        await loadHotelSettings(uid, data);
        setLoading(false);
      } catch (err) {
        console.error("Fout bij laden van gebruikersgegevens:", err);
        setRoles([]);
        setHotelUids([]);
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, []);

  const selectHotel = async (uid) => {
    if (!hotelUids.includes(uid)) return;
    setLoading(true);
    persistSelectedHotelUid(uid);
    setSelectedHotelUid(uid);
    const data = userData;
    await loadHotelSettings(uid, data);
    setLoading(false);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-blue-600 text-xl">
        ⏳ Hotelgegevens laden...
      </div>
    );
  }

  return (
    <HotelContext.Provider
      value={{
        hotelName,
        setHotelName,
        hotelUid: selectedHotelUid,
        hotelUids,
        language,
        loading,
        roles,
        selectHotel,
        lightspeedShiftRolloverHour,
        posProvider,
        setPosProvider,
        orderMode,
        setOrderMode,
      }}
    >
      {children}
    </HotelContext.Provider>
  );
}

export function useHotelContext() {
  return useContext(HotelContext);
}
