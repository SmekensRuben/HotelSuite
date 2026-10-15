import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import AppRouter from "../../AppRouter";

const checks = vi.hoisted(() => ({ latest: null }));
vi.mock("../shared/ProtectedRoute.jsx", () => ({ default: ({ children, ...props }) => { checks.latest = props; return children; } }));
vi.mock("./ProcurementSettingsPage.jsx", () => ({ default: () => { const url = useLocation(); return <p>{url.pathname}{url.search}</p>; } }));
vi.mock("./OutletCreatePage.jsx", () => ({ default: () => <p>Outlet create</p> }));
vi.mock("./OutletDetailPage.jsx", () => ({ default: () => <p>Outlet detail</p> }));
vi.mock("./OutletEditPage.jsx", () => ({ default: () => <p>Outlet edit</p> }));
vi.mock("./LocationCreatePage.jsx", () => ({ default: () => <p>Location create</p> }));
vi.mock("./LocationDetailPage.jsx", () => ({ default: () => <p>Location detail</p> }));
vi.mock("./LocationEditPage.jsx", () => ({ default: () => <p>Location edit</p> }));
vi.mock("./LocationStockTemplateDetailPage.jsx", () => ({ default: () => <p>Stock template detail</p> }));
afterEach(cleanup);
const open = (url) => render(<MemoryRouter initialEntries={[url]}><AppRouter /></MemoryRouter>);

it.each([["catalog", "categories"], ["outlets", "outlets"], ["locations", "locations"]])(
  "preserves the %s list URL as a section link without broadening its settings authority", async (legacy, section) => {
    open(`/settings/${legacy}`);
    await screen.findByText(`/settings/procurement?section=${section}`);
    expect(checks.latest).toEqual({ anyOf: [
      { feature: "catalogsettings", action: "read" }, { feature: "outlets", action: "read" }, { feature: "locations", action: "read" }, { feature: "supplierproducts", action: "read" },
      { feature: "purchasebudgets", action: "settings" },
    ] });
  },
);

it.each([
  ["/settings/outlets/new", "Outlet create", "outlets", "create"],
  ["/settings/outlets/bar", "Outlet detail", "outlets", "read"],
  ["/settings/outlets/bar/edit", "Outlet edit", "outlets", "update"],
  ["/settings/locations/new", "Location create", "locations", "create"],
  ["/settings/locations/store", "Location detail", "locations", "read"],
  ["/settings/locations/store/edit", "Location edit", "locations", "update"],
  ["/settings/locations/store/stock-templates/weekly", "Stock template detail", "locations", "read"],
])("retains the action boundary for the deep link %s", async (url, label, feature, action) => {
  open(url);
  await screen.findByText(label);
  expect(checks.latest).toEqual({ feature, action });
});
