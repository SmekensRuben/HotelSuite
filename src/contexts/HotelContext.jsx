import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { auth, db, doc, getDoc, onSnapshot } from "../firebaseConfig";
import { subscriptionIsActive } from "../utils/subscription";
import { getHotelBootstrap } from "../services/firebaseSettings";
import i18n from "../i18n";
import {
  getSelectedHotelUid,
  setSelectedHotelUid as persistSelectedHotelUid,
} from "../utils/hotelUtils";

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
  const [isHotelAdmin, setIsHotelAdmin] = useState(false);
  const [authorizationSource, setAuthorizationSource] = useState("none");
  const [lightspeedShiftRolloverHour, setLightspeedShiftRolloverHour] = useState(4);
  const [posProvider, setPosProvider] = useState("lightspeed");
  const [orderMode, setOrderMode] = useState("ingredient");
  const [subscription, setSubscription] = useState(null);
  const [subscriptionLoading, setSubscriptionLoading] = useState(true);
  const [subscriptionError, setSubscriptionError] = useState(null);
  const [subscriptionAttempt, setSubscriptionAttempt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const settingsRequest = useRef(0);

  useEffect(() => {
    setPermissions([]); setIsHotelAdmin(false); setPermissionsLoading(true); setAuthorizationSource("none");
    const userUid = auth.currentUser?.uid;
    if (!selectedHotelUid || !userUid) { setPermissionsLoading(false); return; }
    return onSnapshot(doc(db, `hotels/${selectedHotelUid}/members`, userUid), (snapshot) => {
      if (auth.currentUser?.uid !== userUid) return;
      const membership = snapshot.exists() ? snapshot.data() : null;
      setPermissions(Array.isArray(membership?.permissions) ? membership.permissions : []);
      setIsHotelAdmin(membership?.hotelAdmin === true);
      setAuthorizationSource(membership ? "membership" : "missing-membership");
      setPermissionsLoading(false);
    }, () => {
      setPermissions([]); setIsHotelAdmin(false); setAuthorizationSource("error"); setPermissionsLoading(false);
    });
  }, [selectedHotelUid, userData]);

  useEffect(() => {
    setSubscription(null); setSubscriptionLoading(true); setSubscriptionError(null);
    if (!selectedHotelUid || !auth.currentUser) { setSubscriptionLoading(false); return; }
    const stop = onSnapshot(doc(db, "hotelSubscriptions", selectedHotelUid), (snapshot) => {
      setSubscription(snapshot.exists() ? snapshot.data() : null); setSubscriptionLoading(false);
    }, (error) => {
      setSubscription(null); setSubscriptionError(error.code || "unavailable"); setSubscriptionLoading(false);
    });
    const clock = setInterval(() => setNow(Date.now()), 30000);
    return () => { stop(); clearInterval(clock); };
  }, [selectedHotelUid, userData, subscriptionAttempt]);

  useEffect(() => {
    if (language) {
      i18n.changeLanguage(language);
      localStorage.setItem("lang", language);
    }
  }, [language]);

  const loadHotelSettings = async (uid, data, userUid = auth.currentUser?.uid) => {
    if (!uid) return false;
    const request = ++settingsRequest.current;
    const current = () => request === settingsRequest.current && auth.currentUser?.uid === userUid;
    try {
      const [bootstrapResult] = await Promise.allSettled([getHotelBootstrap(uid)]);
      if (!current()) return false;
      // Identity defaults must not erase an independently loaded authorization source.
      const settings = bootstrapResult.status === "fulfilled" ? bootstrapResult.value : {};

      setHotelName(settings.hotelName || "Hotel");
      const preferredLanguage =
        normalizeLanguage(data?.language) || normalizeLanguage(settings.language) || "nl";
      setLanguage(preferredLanguage);
      const rolloverSetting = Number(settings.lightspeedShiftRolloverHour);
      setLightspeedShiftRolloverHour(
        Number.isInteger(rolloverSetting) && rolloverSetting >= 0 && rolloverSetting <= 23 ? rolloverSetting : 4
      );
      setPosProvider(settings.posProvider || "lightspeed");
      setOrderMode(settings.orderMode || "ingredient");
    } catch (err) {
      if (!current()) return false;
      console.error("Failed to load hotel settings:", err);
      setHotelName("Hotel");
      setLanguage("nl");
      setLightspeedShiftRolloverHour(4);
      setPosProvider("lightspeed");
      setOrderMode("ingredient");
    }
    return current();
  };

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged(async (user) => {
      if (!user?.uid) {
        ++settingsRequest.current;
        setPermissions([]);
        setPermissionsLoading(false);
        setHotelUids([]);
        setUserData(null);
        setIsPlatformAdmin(false);
        setIsHotelAdmin(false);
        setAuthorizationSource("none");
        persistSelectedHotelUid(null);
        setSelectedHotelUid(null);
        setLoading(false);
        return;
      }

      try {
        const [userSnap, tokenResult] = await Promise.all([
          getDoc(doc(db, "users", user.uid)),
          user.getIdTokenResult(),
        ]);
        if (auth.currentUser?.uid !== user.uid) return;
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
        if (await loadHotelSettings(uid, data, user.uid)) setLoading(false);
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
    if (await loadHotelSettings(uid, data, auth.currentUser?.uid)) setLoading(false);
  };

  const refreshHotelAssignments = async () => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const profile = await getDoc(doc(db, "users", uid));
    if (auth.currentUser?.uid !== uid || !profile.exists()) return;
    const data = profile.data();
    setUserData(data);
    setHotelUids(Array.isArray(data.hotelUid) ? data.hotelUid : []);
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
        isHotelAdmin,
        authorizationSource,
        subscription,
        subscriptionLoading,
        subscriptionError,
        retrySubscription: () => setSubscriptionAttempt((attempt) => attempt + 1),
        subscriptionActive: subscriptionIsActive(subscription, now),
        selectHotel,
        refreshHotelAssignments,
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
