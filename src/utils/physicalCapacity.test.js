import { describe, expect, it } from "vitest";
import { calculatePhysicalFeasibility } from "./physicalCapacity";

const calculate = (roomsByDate, forecastByDate) => calculatePhysicalFeasibility({ roomsByDate, forecastByDate });

describe("physical capacity feasibility", () => {
  it("marks a request within current hard capacity feasible", () => {
    const result = calculate([{ date: "2027-03-19", rooms: 100 }], { "2027-03-19": { sellableInventory: 150, currentTransientOtb: 10, existingGroupOtb: 20 } });
    expect(result.status).toBe("PHYSICALLY_FEASIBLE");
    expect(result.perDate[0]).toMatchObject({ remainingPhysicalCapacity: 120, capacityShortfallRooms: 0, feasible: true });
  });
  it("marks a request above current hard capacity infeasible", () => {
    const result = calculate([{ date: "2027-03-19", rooms: 150 }], { "2027-03-19": { sellableInventory: 150, currentTransientOtb: 3, existingGroupOtb: 0 } });
    expect(result.status).toBe("PHYSICAL_CAPACITY_SHORTFALL");
    expect(result.perDate[0]).toMatchObject({ remainingPhysicalCapacity: 147, capacityShortfallRooms: 3, feasible: false });
  });
  it("summarizes the three-night shortfall and uniform feasible block", () => {
    const rooms = [19, 20, 21].map((day) => ({ date: `2027-03-${day}`, rooms: 150 }));
    const forecasts = Object.fromEntries(rooms.map((night, index) => [night.date, { sellableInventory: 150, currentTransientOtb: index ? 6 : 3, existingGroupOtb: 0 }]));
    expect(calculate(rooms, forecasts)).toMatchObject({ requestedRoomNights: 450, physicallyFeasibleRequestedRoomNights: 435, totalCapacityShortfallRoomNights: 15, maxUniformRoomsCurrentlyFeasible: 144, status: "PHYSICAL_CAPACITY_SHORTFALL" });
  });
  it("does not treat non-deductible pipeline rooms as hard committed", () => {
    const result = calculate([{ date: "2027-03-19", rooms: 100 }], { "2027-03-19": { sellableInventory: 150, currentTransientOtb: 10, existingGroupOtb: 20, groupRoomsNonDeductible: 80 } });
    expect(result.perDate[0].hardCommittedRooms).toBe(30);
    expect(result.status).toBe("PHYSICALLY_FEASIBLE");
  });
});
