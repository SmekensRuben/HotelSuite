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
  const [permissionsLoading, setPermissionsLoading] = useState(true);
  const [permissions, setPermissions] = useState([]);
  const [userData, setUserData] = useState(null);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [authorizationSource, setAuthorizationSource] = useState("none");
  const [lightspeedShiftRolloverHour, setLightspeedShiftRolloverHour] = useState(4);
  const [posProvider, setPosProvider] = useState("lightspeed");
  const [orderMode, setOrderMode] = useState("ingredient");

  useEffect(() => {
    if (language) {
      i18n.changeLanguage(language);
      localStorage.setItem("lang", language);
    }
  }, [language]);

  const loadHotelSettings = async (uid, data, userUid = auth.currentUser?.uid) => {
    if (!uid) return;
    setPermissionsLoading(true);

    try {
      const settingsRef = doc(db, `hotels/${uid}/settings`, uid);
      const membershipRef = userUid ? doc(db, `hotels/${uid}/members`, userUid) : null;
      const [settingsSnap, membershipSnap] = await Promise.all([
        getDoc(settingsRef),
        membershipRef ? getDoc(membershipRef) : Promise.resolve(null),
      ]);
      const settings = settingsSnap.exists() ? settingsSnap.data() : {};
      const membership = membershipSnap?.exists() ? membershipSnap.data() : null;
      if (membership) {
        setPermissions(Array.isArray(membership.permissions) ? membership.permissions : []);
        setAuthorizationSource("membership");
      } else {
        // Temporary read-only migration compatibility. Security Rules use
        // per-hotel membership documents and never trust this global fallback.
        setPermissions(Array.isArray(data?.permissions) ? data.permissions : []);
        setAuthorizationSource("legacy-user-profile");
      }

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
    } catch (err) {
      console.error("Fout bij laden van hotelinstellingen:", err);
      setHotelName("Hotel");
      setLanguage("nl");
      setLightspeedShiftRolloverHour(4);
    } finally {
      setPermissionsLoading(false);
    }
  };

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged(async (user) => {
      if (!user?.uid) {
        setPermissions([]);
        setPermissionsLoading(false);
        setHotelUids([]);
        setUserData(null);
        setIsPlatformAdmin(false);
        setAuthorizationSource("none");
        persistSelectedHotelUid(null);
        setLoading(false);
        return;
      }

      try {
        const [userSnap, tokenResult] = await Promise.all([
          getDoc(doc(db, "users", user.uid)),
          user.getIdTokenResult(),
        ]);
        setIsPlatformAdmin(tokenResult?.claims?.platformAdmin === true);

        if (!userSnap.exists()) {
          console.error("Gebruikersprofiel niet gevonden in database.");
          setPermissions([]);
          setPermissionsLoading(false);
          setLoading(false);
          return;
        }

        const data = userSnap.data();
        setUserData(data);

        const hotels = Array.isArray(data?.hotelUid) ? data.hotelUid : [];
        if (!hotels.length) {
          console.error("hotelUid ontbreekt in gebruikersprofiel.");
          setPermissions([]);
          setPermissionsLoading(false);
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
        await loadHotelSettings(uid, data, user.uid);
        setLoading(false);
      } catch (err) {
        console.error("Fout bij laden van gebruikersgegevens:", err);
        setPermissions([]);
        setPermissionsLoading(false);
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
    await loadHotelSettings(uid, data, auth.currentUser?.uid);
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
        permissionsLoading,
        permissions,
        isPlatformAdmin,
        authorizationSource,
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
