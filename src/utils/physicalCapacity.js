export const PHYSICAL_FEASIBILITY_VERSION = "physical-feasibility-v1";
export const PHYSICAL_FEASIBILITY_STATUS = Object.freeze({
  FEASIBLE: "PHYSICALLY_FEASIBLE",
  SHORTFALL: "PHYSICAL_CAPACITY_SHORTFALL",
});

const nonNegative = (value) => Math.max(0, Number(value) || 0);

/** A current-hard-capacity check. It intentionally does not use forecasts or pipeline rooms. */
export function calculatePhysicalFeasibility({ roomsByDate = [], forecastByDate = {} }) {
  const perDate = roomsByDate.map((request) => {
    const source = forecastByDate[request.date] || {};
    const inventory = nonNegative(source.sellableInventory);
    const transientOtb = nonNegative(source.currentTransientOtb);
    const groupOtb = nonNegative(source.existingGroupOtb);
    const hardOtherCommittedRooms = nonNegative(source.hardOtherCommittedRooms);
    const hardCommittedRooms = transientOtb + groupOtb + hardOtherCommittedRooms;
    const remainingPhysicalCapacity = Math.max(0, inventory - hardCommittedRooms);
    const requestedRooms = nonNegative(request.rooms);
    const capacityShortfallRooms = Math.max(0, requestedRooms - remainingPhysicalCapacity);
    return { date: request.date, inventory, transientOtb, groupOtb, hardOtherCommittedRooms, hardCommittedRooms, remainingPhysicalCapacity, requestedRooms, capacityShortfallRooms, feasible: capacityShortfallRooms === 0 };
  });
  const requestedRoomNights = perDate.reduce((sum, night) => sum + night.requestedRooms, 0);
  const physicallyFeasibleRequestedRoomNights = perDate.reduce((sum, night) => sum + Math.min(night.requestedRooms, night.remainingPhysicalCapacity), 0);
  const totalCapacityShortfallRoomNights = perDate.reduce((sum, night) => sum + night.capacityShortfallRooms, 0);
  const uniformRequest = perDate.length > 0 && perDate.every((night) => night.requestedRooms === perDate[0].requestedRooms);
  return {
    version: PHYSICAL_FEASIBILITY_VERSION,
    displacementBasis: "STAY_DATE",
    status: totalCapacityShortfallRoomNights > 0 ? PHYSICAL_FEASIBILITY_STATUS.SHORTFALL : PHYSICAL_FEASIBILITY_STATUS.FEASIBLE,
    requestedRoomNights,
    physicallyFeasibleRequestedRoomNights,
    totalCapacityShortfallRoomNights,
    maxUniformRoomsCurrentlyFeasible: uniformRequest ? Math.min(...perDate.map((night) => night.remainingPhysicalCapacity)) : null,
    perDate,
  };
}
