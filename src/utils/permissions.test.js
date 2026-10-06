import { describe, expect, it } from "vitest";
import { hasPermission } from "./permissions";

describe("hasPermission", () => {
  it("denies Front Office access when the selected-hotel permission list is empty", () => {
    expect(hasPermission({ permissions: [] }, "reservations", "read")).toBe(false);
  });

  it("allows Front Office access with reservations.read", () => {
    expect(hasPermission({ permissions: ["reservations.read"] }, "reservations", "read")).toBe(true);
  });

  it("allows every hotel action with super.admin", () => {
    expect(hasPermission({ permissions: ["super.admin"] }, "reservations", "read")).toBe(true);
    expect(hasPermission({ permissions: ["super.admin"] }, "contracts", "delete")).toBe(true);
  });
});
