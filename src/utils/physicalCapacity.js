export const PHYSICAL_FEASIBILITY_VERSION = "physical-feasibility-v2-required-inputs";
export const PHYSICAL_FEASIBILITY_STATUS = Object.freeze({
  FEASIBLE: "PHYSICALLY_FEASIBLE",
  SHORTFALL: "PHYSICAL_CAPACITY_SHORTFALL",
  UNAVAILABLE: "PHYSICAL_CAPACITY_UNAVAILABLE",
});

const nonNegative = (value) => Math.max(0, Number(value) || 0);
const known = (value) => (typeof value === "number" || typeof value === "string") && String(value).trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0;

/** A current-hard-capacity check. It intentionally does not use forecasts or pipeline rooms. */
export function calculatePhysicalFeasibility({ roomsByDate = [], forecastByDate = {} }) {
  const perDate = roomsByDate.map((request) => {
    const source = forecastByDate[request.date] || {};
    const inputsAvailable = (source.hardOtherCommittedRooms === undefined || known(source.hardOtherCommittedRooms)) && [source.sellableInventory, source.currentTransientOtb, source.existingGroupOtb, request.rooms].every(known);
    if (!inputsAvailable) return { date: request.date, inputsAvailable: false, inventory: null, transientOtb: null, groupOtb: null, hardOtherCommittedRooms: null, hardCommittedRooms: null, remainingPhysicalCapacity: null, requestedRooms: known(request.rooms) ? Number(request.rooms) : null, capacityShortfallRooms: null, feasible: false };
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
  const inputsAvailable = perDate.every((night) => night.inputsAvailable !== false);
  const requestedRoomNights = perDate.some((night) => night.requestedRooms === null) ? null : perDate.reduce((sum, night) => sum + night.requestedRooms, 0);
  const physicallyFeasibleRequestedRoomNights = inputsAvailable ? perDate.reduce((sum, night) => sum + Math.min(night.requestedRooms, night.remainingPhysicalCapacity), 0) : null;
  const totalCapacityShortfallRoomNights = inputsAvailable ? perDate.reduce((sum, night) => sum + night.capacityShortfallRooms, 0) : null;
  const uniformRequest = perDate.length > 0 && perDate.every((night) => night.requestedRooms === perDate[0].requestedRooms);
  return {
    version: PHYSICAL_FEASIBILITY_VERSION,
    displacementBasis: "STAY_DATE",
    status: !inputsAvailable ? PHYSICAL_FEASIBILITY_STATUS.UNAVAILABLE : totalCapacityShortfallRoomNights > 0 ? PHYSICAL_FEASIBILITY_STATUS.SHORTFALL : PHYSICAL_FEASIBILITY_STATUS.FEASIBLE,
    inputsAvailable,
    requestedRoomNights,
    physicallyFeasibleRequestedRoomNights,
    totalCapacityShortfallRoomNights,
    maxUniformRoomsCurrentlyFeasible: inputsAvailable && uniformRequest ? Math.min(...perDate.map((night) => night.remainingPhysicalCapacity)) : null,
    perDate,
  };
}
