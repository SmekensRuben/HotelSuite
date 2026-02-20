import React, { createContext, useContext, useEffect, useState } from "react";
import { auth, db, doc, getDoc } from "../firebaseConfig";
import i18n from "../i18n";
import {
  getSelectedHotelUid,
  setSelectedHotelUid as persistSelectedHotelUid,
} from "utils/hotelUtils";
import { getRoles } from "../services/firebaseRoles";
import { ROLE_PERMISSIONS } from "../constants/roles";

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
  const [rolePermissions, setRolePermissions] = useState(ROLE_PERMISSIONS);
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

      const loadedRoles = await getRoles(uid);
      const customPermissions = loadedRoles.reduce((accumulator, role) => {
        const roleName = String(role.name || "").trim();
        const roleId = String(role.id || "").trim();
        const permissions = Array.isArray(role.permissions) ? role.permissions : [];

        if ((!roleName && !roleId) || permissions.length === 0) {
          return accumulator;
        }

        const mapped = permissions.reduce((permissionAccumulator, permissionKey) => {
          const [rawFeature, rawAction] = String(permissionKey || "").split(".");
          const feature = String(rawFeature || "").trim().toLowerCase();
          const action = String(rawAction || "").trim().toLowerCase();
          if (!feature || !action) {
            return permissionAccumulator;
          }

          if (!permissionAccumulator[feature]) {
            permissionAccumulator[feature] = [];
          }

          if (!permissionAccumulator[feature].includes(action)) {
            permissionAccumulator[feature].push(action);
          }
          return permissionAccumulator;
        }, {});

        if (roleName) {
          accumulator[roleName] = mapped;
          accumulator[roleName.toLowerCase()] = mapped;
        }

        if (roleId) {
          accumulator[roleId] = mapped;
          accumulator[roleId.toLowerCase()] = mapped;
        }

        return accumulator;
      }, {});

      setRolePermissions({
        ...ROLE_PERMISSIONS,
        ...customPermissions,
      });
    } catch (err) {
      console.error("Fout bij laden van hotelinstellingen:", err);
      setHotelName("Hotel");
      setLanguage("nl");
      setLightspeedShiftRolloverHour(4);
      setRoles([]);
      setRolePermissions(ROLE_PERMISSIONS);
    }
  };

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged(async (user) => {
      if (!user?.uid) {
        setRoles([]);
        setRolePermissions(ROLE_PERMISSIONS);
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
          setRolePermissions(ROLE_PERMISSIONS);
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
          setRolePermissions(ROLE_PERMISSIONS);
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
        setRolePermissions(ROLE_PERMISSIONS);
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
        rolePermissions,
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
