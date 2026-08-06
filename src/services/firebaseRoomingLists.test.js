import { describe, expect, it } from "vitest";
import { calculateRoomingListChanges, calculateRoomTypePickupSummary } from "./firebaseRoomingLists";

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

describe("calculateRoomTypePickupSummary", () => {
  it("compares official and requested pickup by room type and day", () => {
    const roomTypeDays = [
      { date: "2026-09-14", roomTypes: [{ code: "KING", name: "King", quantity: 3 }, { code: "TWIN", name: "Twin", quantity: 2 }] },
      { date: "2026-09-15", roomTypes: [{ code: "KING", name: "King", quantity: 2 }] },
    ];
    const official = [reservation("one", { departureDate: "2026-09-16" })];
    const requested = [...official, reservation("two", { arrivalDate: "2026-09-14", departureDate: "2026-09-15" })];
    const summary = calculateRoomTypePickupSummary(roomTypeDays, official, requested);

    expect(summary.days[0].roomTypes[0]).toMatchObject({ blocked: 3, officialPickedUp: 1, requestedPickedUp: 2, pickupChange: 1, remaining: 1 });
    expect(summary.days[1].roomTypes[0]).toMatchObject({ officialPickedUp: 1, requestedPickedUp: 1, pickupChange: 0, remaining: 1 });
    expect(summary.totals).toEqual({ blocked: 7, officialPickedUp: 2, requestedPickedUp: 3, remaining: 4 });
  });
});
