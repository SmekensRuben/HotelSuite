import React from "react";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DashboardPage from "./DashboardPage";

let context;
vi.mock("../../contexts/HotelContext", () => ({
  useHotelContext: () => context,
}));
vi.mock("../../firebaseConfig", () => ({
  auth: { currentUser: { uid: "employee" } },
  signOut: vi.fn(),
  db: {},
  doc: vi.fn(),
  getDoc: vi.fn(),
}));
const show = () =>
  render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
beforeEach(() => {
  context = {
    hotelUid: "hotel-a",
    hotelUids: [],
    hotelName: "Sample Hotel",
    subscriptionActive: true,
    subscription: { modules: ["procurement"], modulePolicyVersion: 1 },
    permissions: ["orders.read"],
    isHotelAdmin: false,
    isPlatformAdmin: false,
  };
});

describe("hotel workspace shortcuts", () => {
  it("links an orders-only reader to the allowed order workflow", () => {
    show();
    const workflows = screen.getByRole("region", {
      name: "Available hotel workflows",
    });
    expect(
      within(workflows).getByRole("link", { name: /Purchasing & Inventory/ }),
    ).toHaveAttribute("href", "/orders");
    expect(
      within(workflows).queryByText("Revenue & Forecasting"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Hotel team" }),
    ).not.toBeInTheDocument();
  });
  it("does not expose a licensed-looking shortcut from dormant permissions", () => {
    context.subscription.modules = [];
    context.permissions = ["orders.read", "groupquotes.read"];
    show();
    expect(
      screen.queryByRole("region", { name: "Available hotel workflows" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Your workspace is ready for access setup"),
    ).toBeVisible();
  });
  it.each([
    ["supplierproducts.read", "/catalog/supplier-products"],
    ["suppliers.read", "/catalog/suppliers"],
  ])(
    "routes a %s reader to their permitted purchasing workflow",
    (permission, destination) => {
      context.permissions = [permission];
      show();
      const workflows = screen.getByRole("region", {
        name: "Available hotel workflows",
      });
      expect(
        within(workflows).getByRole("link", { name: /Purchasing & Inventory/ }),
      ).toHaveAttribute("href", destination);
      expect(
        screen.queryByText("Your workspace is ready for access setup"),
      ).not.toBeInTheDocument();
    },
  );
  it("keeps platform administration separate from operational access", () => {
    context.isPlatformAdmin = true;
    context.permissions = [];
    show();
    expect(
      screen.getAllByRole("link", { name: "Platform console" })[0],
    ).toHaveAttribute("href", "/platform");
    expect(
      screen.queryByRole("region", { name: "Available hotel workflows" }),
    ).not.toBeInTheDocument();
  });
});
