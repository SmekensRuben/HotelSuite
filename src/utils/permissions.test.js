import { describe, expect, it } from "vitest";
import { hasPermission } from "./permissions";

describe("hasPermission", () => {
  it("denies Front Office access when the selected-hotel permission list is empty", () => {
    expect(hasPermission({ permissions: [] }, "reservations", "read")).toBe(false);
  });

  it("allows Front Office access with reservations.read", () => {
    expect(hasPermission({ permissions: ["reservations.read"] }, "reservations", "read")).toBe(true);
  });
  it("requires explicit receiving grants while preserving legacy wildcard actions", () => {
    expect(hasPermission({ permissions: ["orders.*"] }, "orders", "approve")).toBe(true);
    for (const action of ["receive", "finalize"]) {
      expect(hasPermission({ permissions: ["orders.*"] }, "orders", action)).toBe(false);
      expect(hasPermission({ permissions: [`orders.${action}`] }, "orders", action)).toBe(true);
    }
  });
  it("requires an explicit supervisor grant to reverse manual movements", () => {
    expect(hasPermission({ permissions: ["inventorymovements.*"] }, "inventorymovements", "create")).toBe(true);
    expect(hasPermission({ permissions: ["inventorymovements.*"] }, "inventorymovements", "reverse")).toBe(false);
    expect(hasPermission({ permissions: ["inventorymovements.reverse"] }, "inventorymovements", "reverse")).toBe(true);
    expect(hasPermission({ permissions: ["stockcounts.*"] }, "inventorymovements", "create")).toBe(false);
  });
  it("requires selected purchase request decision and workflow settings grants", () => {
    for (const action of ["submit", "approve", "selfapprove", "cancel"]) {
      expect(hasPermission({ permissions: ["purchaserequests.*"] }, "purchaserequests", action)).toBe(false);
      expect(hasPermission({ permissions: [`purchaserequests.${action}`] }, "purchaserequests", action)).toBe(true);
    }
    expect(hasPermission({ permissions: ["purchaserequests.*"] }, "purchaserequests", "create")).toBe(true);
    expect(hasPermission({ permissions: ["purchasebudgets.*"] }, "purchasebudgets", "settings")).toBe(false);
    expect(hasPermission({ permissions: ["purchasebudgets.settings"] }, "purchasebudgets", "settings")).toBe(true);
  });
  it("requires explicit recovery grants independently of approval and wildcard access", () => {
    for (const feature of ["orders", "purchaserequests"]) {
      expect(hasPermission({ permissions: [`${feature}.*`, `${feature}.approve`] }, feature, "recover")).toBe(false);
      expect(hasPermission({ permissions: [`${feature}.recover`] }, feature, "recover")).toBe(true);
      expect(hasPermission({ permissions: [`${feature}.recover`] }, feature, "approve")).toBe(false);
    }
    expect(hasPermission({ permissions: ["purchaserequests.recover"] }, "purchaserequests", "selfapprove")).toBe(false);
    expect(hasPermission({ permissions: ["purchaserequests.recover"] }, "purchasebudgets", "settings")).toBe(false);
  });
});
