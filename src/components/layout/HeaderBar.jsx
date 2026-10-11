import React, { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useHotelContext } from "../../contexts/HotelContext";
import { db, doc, getDoc } from "../../firebaseConfig";
import {
  BedDouble,
  BellRing,
  BriefcaseBusiness,
  CalendarDays,
  ClipboardList,
  FileText,
  LayoutDashboard,
  LogOut,
  Package,
  Settings2,
  ShoppingBasket,
  Sparkles,
  TrendingUp,
  Truck,
  Users,
} from "lucide-react";
import { usePermission } from "../../hooks/usePermission";
import WorkspaceChrome from "./WorkspaceChrome";

export default function HeaderBar({ today, onLogout }) {
  const location = useLocation();
  const { t } = useTranslation(["common", "reservations"]);
  const {
    hotelUid,
    hotelUids = [],
    hotelName,
    selectHotel,
    isPlatformAdmin,
    isHotelAdmin,
  } = useHotelContext();
  const canViewCatalogProducts = usePermission("catalogproducts", "read");
  const canViewSupplierProducts = usePermission("supplierproducts", "read");
  const canViewSuppliers = usePermission("suppliers", "read");
  const canViewOrders = usePermission("orders", "read");
  const canViewContracts = usePermission("contracts", "read");
  const canViewStockCounts = usePermission("stockcounts", "read");
  const canViewPropertySettings = usePermission("propertysettings", "read");
  const canViewCatalogSettings = usePermission("catalogsettings", "read");
  const canViewOutlets = usePermission("outlets", "read");
  const canViewImports = usePermission("imports", "read");
  const canViewIntegrations = usePermission("integrations", "read");
  const canViewNotifications = usePermission("notifications", "read");
  const canViewReservations = usePermission("reservations", "read");
  const canViewLocations = usePermission("locations", "read");
  const canReadAuditUpsells = usePermission("auditUpsells", "read");
  const canManageAuditUpsells = usePermission("auditUpsells", "settings");
  const canViewGroups = usePermission("groups", "read");
  const canViewGroupQuotes = usePermission("groupquotes", "read");
  const canViewDemandCalendar = usePermission("demandcalendar", "read");
  const canViewCommercialIntelligence = usePermission(
    "commercialintelligence",
    "read",
  );
  const [hotels, setHotels] = useState([]);
  const [switchError, setSwitchError] = useState("");
  const hotelKey = hotelUids.join("\u0000");

  useEffect(() => {
    let current = true;
    const ids = hotelKey ? hotelKey.split("\u0000") : [];
    setHotels(ids.map((uid) => ({ uid, name: uid })));
    Promise.all(
      ids.map(async (uid) => {
        try {
          const snap = await getDoc(
            doc(db, `hotels/${uid}/settings`, "bootstrap"),
          );
          return {
            uid,
            name: snap.exists() ? snap.data().hotelName || uid : uid,
          };
        } catch {
          return { uid, name: uid };
        }
      }),
    ).then((next) => {
      if (current) setHotels(next);
    });
    return () => {
      current = false;
    };
  }, [hotelKey]);
  useEffect(() => {
    setSwitchError("");
  }, [hotelUid]);

  if (location.pathname.startsWith("/platform")) return null;
  const visible = (items) => items.filter((item) => item.visible === true);
  const groups = [
    {
      label: "Workspace",
      items: [
        {
          to: "/dashboard",
          label: "Overview",
          icon: LayoutDashboard,
          end: true,
        },
      ],
    },
    {
      label: "Purchasing & Inventory",
      items: visible([
        {
          to: "/catalog/products",
          label: "Catalog Products",
          icon: Package,
          visible: canViewCatalogProducts,
        },
        {
          to: "/catalog/supplier-products",
          label: "Supplier Products",
          icon: Package,
          visible: canViewSupplierProducts,
        },
        {
          to: "/catalog/suppliers",
          label: "Suppliers",
          icon: Truck,
          visible: canViewSuppliers,
        },
        {
          to: "/orders",
          label: "Orders",
          icon: ShoppingBasket,
          visible: canViewOrders,
        },
        {
          to: "/catalog/stock-counts",
          label: "Stock Count",
          icon: ClipboardList,
          visible: canViewStockCounts,
        },
      ]),
    },
    {
      label: "Groups & Events",
      items: visible([
        {
          to: "/me/groups",
          label: "Groups",
          icon: BriefcaseBusiness,
          visible: canViewGroups,
        },
      ]),
    },
    {
      label: "Revenue",
      items: visible([
        {
          to: "/me/demand-calendar",
          label: "Demand Calendar",
          icon: CalendarDays,
          visible: canViewDemandCalendar,
        },
        {
          to: "/revenue/commercial-intelligence",
          label: "Commercial Intelligence",
          icon: TrendingUp,
          visible: canViewCommercialIntelligence,
        },
        {
          to: "/revenue/group-quotes",
          label: "Group Quotes",
          icon: TrendingUp,
          visible: canViewGroupQuotes,
        },
      ]),
    },
    {
      label: "Front Office",
      items: visible([
        {
          to: "/front-office/arrivals",
          label: "Arrivals",
          icon: BedDouble,
          visible: canViewReservations,
        },
        {
          to: "/front-office/made-reservations",
          label: "Made Reservations",
          icon: ClipboardList,
          visible: canViewReservations,
        },
        {
          to: canReadAuditUpsells
            ? "/front-office/upselling"
            : "/front-office/upselling/audit",
          label: "Upselling",
          icon: Sparkles,
          visible: canReadAuditUpsells || canManageAuditUpsells,
        },
      ]),
    },
    {
      label: "Administration",
      items: visible([
        {
          to: "/contracts",
          label: "Contracts",
          icon: FileText,
          visible: canViewContracts,
        },
        {
          to: "/settings/team",
          label: "Hotel team",
          icon: Users,
          visible: isHotelAdmin,
        },
        {
          to: "/settings/property",
          label: "Property Settings",
          icon: Settings2,
          visible: canViewPropertySettings,
        },
        {
          to: "/settings/catalog",
          label: "Catalog Settings",
          icon: Settings2,
          visible: canViewCatalogSettings,
        },
        {
          to: "/settings/outlets",
          label: "Outlet Settings",
          icon: Settings2,
          visible: canViewOutlets,
        },
        {
          to: "/settings/locations",
          label: "Location Settings",
          icon: Settings2,
          visible: canViewLocations,
        },
        {
          to: "/settings/file-import",
          label: "File Import Settings",
          icon: Settings2,
          visible: canViewImports,
        },
        {
          to: "/settings/file-import-types",
          label: "File Import Types",
          icon: Settings2,
          visible: canViewImports,
        },
        {
          to: "/settings/opera",
          label: "Opera Settings",
          icon: Settings2,
          visible: canViewIntegrations,
        },
        {
          to: "/settings/notification-lists",
          label: "Notification Lists",
          icon: BellRing,
          visible: canViewNotifications,
        },
        {
          to: "/platform",
          label: "Platform console",
          icon: Settings2,
          visible: isPlatformAdmin,
        },
      ]),
    },
  ];
  const changeHotel = async (uid) => {
    setSwitchError("");
    try {
      await selectHotel?.(uid);
    } catch {
      setSwitchError("We could not switch hotels. Please try again.");
    }
  };
  return (
    <WorkspaceChrome
      groups={groups}
      subtitle="Hotel workspace"
      footer={
        <>
          <p className="font-medium text-brand-800">
            Your hotel. Working better together.
          </p>
          {today && <p className="mt-1">{today}</p>}
        </>
      }
      actions={
        <>
          <label className="block max-w-[128px] sm:max-w-[180px]">
            <span className="sr-only">Selected hotel</span>
            <select
              aria-label="Selected hotel"
              value={hotelUid || ""}
              onChange={(event) => changeHotel(event.target.value)}
              className="max-w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-medium text-gray-700"
            >
              {!hotels.length && (
                <option value={hotelUid || ""}>
                  {hotelName || hotelUid || "Hotel workspace"}
                </option>
              )}
              {hotels.map((hotel) => (
                <option key={hotel.uid} value={hotel.uid}>
                  {hotel.name}
                </option>
              ))}
            </select>
          </label>
          {switchError && (
            <span
              role="alert"
              className="absolute right-4 top-[calc(100%+0.5rem)] max-w-[calc(100vw-2rem)] rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 shadow-panel sm:max-w-sm"
            >
              {switchError}
            </span>
          )}
          <button
            type="button"
            onClick={onLogout}
            className="ht-icon-button sm:w-auto sm:gap-2 sm:px-3"
            aria-label={t("logout")}
          >
            <LogOut size={16} aria-hidden="true" />
            <span className="hidden text-xs font-medium sm:inline">
              {t("logout")}
            </span>
          </button>
        </>
      }
    />
  );
}
