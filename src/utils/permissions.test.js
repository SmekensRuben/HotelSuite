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
});
