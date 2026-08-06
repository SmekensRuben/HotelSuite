import { describe, expect, it } from "vitest";
import { calculateRoomingListChanges } from "./firebaseRoomingLists";

const reservation = (id, overrides = {}) => ({ id, firstName: "Ada", lastName: "Lovelace", arrivalDate: "2026-09-14", departureDate: "2026-09-15", roomType: "KING", numberOfAdults: 1, numberOfChildren: 0, comment: "", ...overrides });

describe("calculateRoomingListChanges", () => {
  it("matches permanent reservation ids and categorizes changes", () => {
    const result = calculateRoomingListChanges([reservation("same"), reservation("removed")], [reservation("same", { departureDate: "2026-09-16" }), reservation("added")]);
    expect(result.added.map(({ id }) => id)).toEqual(["added"]);
    expect(result.removed.map(({ id }) => id)).toEqual(["removed"]);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].fields).toEqual([{ field: "departureDate", from: "2026-09-15", to: "2026-09-16" }]);
  });

  it("does not report unchanged reservations", () => {
    expect(calculateRoomingListChanges([reservation("stable")], [reservation("stable")])).toEqual({ added: [], removed: [], changed: [] });
  });
});
