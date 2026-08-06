import { describe, expect, it } from "vitest";
import { calculateRoomingListDeadline, getRoomingListDeadlineDays } from "./groupDeadline";

describe("group rooming list deadlines", () => {
  it("subtracts the configured number of days from the arrival date", () => {
    expect(calculateRoomingListDeadline("2026-03-05", 10)).toBe("2026-02-23");
  });

  it("supports a zero-day deadline", () => {
    expect(calculateRoomingListDeadline("2026-03-05", "0")).toBe("2026-03-05");
  });

  it("rejects invalid day values", () => {
    expect(calculateRoomingListDeadline("2026-03-05", -1)).toBe("");
    expect(calculateRoomingListDeadline("2026-03-05", 1.5)).toBe("");
  });

  it("derives days from the saved date for legacy groups", () => {
    expect(getRoomingListDeadlineDays({
      arrival: "2026-03-05",
      roomingListDeadline: "2026-02-23",
    })).toBe(10);
  });
});
