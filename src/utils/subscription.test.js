import { describe, expect, it } from "vitest";
import { subscriptionIsActive } from "./subscription";

describe("hotel subscription access", () => {
  it("rejects missing, suspended, malformed and expired subscriptions", () => {
    for (const subscription of [null, { status: "suspended" }, { status: "trialing", validUntil: null },
      { status: "active", validUntil: "invalid" }, { status: "active", validUntil: { toMillis: () => 100 } }]) {
      expect(subscriptionIsActive(subscription, 100)).toBe(false);
    }
  });
  it("allows a manually activated hotel or an unexpired trial", () => {
    expect(subscriptionIsActive({ status: "active", validUntil: null }, 100)).toBe(true);
    expect(subscriptionIsActive({ status: "trialing", validUntil: { toMillis: () => 101 } }, 100)).toBe(true);
  });
});
