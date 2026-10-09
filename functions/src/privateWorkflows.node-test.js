const { test } = require("node:test");
const assert = require("node:assert/strict");
const { contractInput, filesOf } = require("./contractFiles");
const { nights, reservationInput, validateReservations, capacitySnapshot, publicView, rateUpdate } = require("./roomingLists");
const { Timestamp } = require("firebase-admin/firestore");
const reservation = (patch = {}) => ({ firstName: "Ada", lastName: "Lovelace", arrivalDate: "2026-10-12", departureDate: "2026-10-14", roomType: "KING", numberOfAdults: 1, numberOfChildren: 0, comment: "", ...patch });
const root = { arrival: "2026-10-12", departure: "2026-10-14", roomTypeDays: ["2026-10-12", "2026-10-13"].map((date) => ({ date, roomTypes: [{ code: "KING", name: "King", quantity: 1 }] })) };
test("rooming dates are valid UTC calendar dates with checkout-exclusive capacity for every night", () => {
  assert.deepEqual(nights("2026-10-12", "2026-10-14"), ["2026-10-12", "2026-10-13"]);
  for (const date of ["2026-02-30", "2026-10-12T00:00:00Z", "2026-13-01"]) assert.throws(() => nights(date, "2026-10-14"));
  const one = reservationInput(reservation(), "reservation-a");
  assert.doesNotThrow(() => validateReservations(root, [one]));
  assert.throws(() => validateReservations(root, [one, { ...one, id: "reservation-b" }]), /available/);
  assert.throws(() => validateReservations(root, [{ ...one, arrivalDate: "2026-10-11" }]), /group/);
  assert.throws(() => validateReservations(root, [{ ...one, roomType: "UNKNOWN" }]), /available/);
  assert.throws(() => capacitySnapshot([...root.roomTypeDays, root.roomTypeDays[0]]));
});
test("reservations reject spoofed approval/identity fields, malformed names, guest counts and excessive input", () => {
  for (const patch of [{ status: "Approved" }, { hotelUid: "hotel-b" }, { createdBy: "operator" }, { numberOfAdults: 0 }, { numberOfChildren: -1 }, { numberOfAdults: 1.5 }, { comment: "x".repeat(1001) }, { firstName: "" }]) assert.throws(() => reservationInput(reservation(patch), "reservation-a"));
  assert.throws(() => validateReservations(root, Array.from({ length: 201 }, (_, i) => ({ id: "r" + i, ...reservation() }))));
});
test("rooming document bounds count UTF-8 bytes rather than only characters", () => {
  const largeRoot = { ...root, roomTypeDays: root.roomTypeDays.map((day) => ({ ...day, roomTypes: [{ code: "KING", name: "King", quantity: 500 }] })) };
  const rows = Array.from({ length: 200 }, (_, i) => ({ id: "r" + i, ...reservation({ comment: "漢".repeat(1000) }) }));
  assert.throws(() => validateReservations(largeRoot, rows), (e) => e.code === "resource-exhausted");
});
test("public rooming projections omit internal authority, approval notes and private history", () => {
  const view = publicView("a".repeat(48), { ...root, groupName: "Conference", status: "Submitted", reservations: [{ id: "a", ...reservation(), actorUid: "private" }], publicAccessExpiresAt: Timestamp.fromMillis(Date.now() + 1000), createdBy: "private", mutationTotal: 20 }, { id: "request", status: "Draft", number: 1, baseVersionNumber: 1, rejectionReason: "Internal", approvedBy: "private", reservations: [] });
  for (const field of ["hotelUid", "createdBy", "mutationTotal", "rejectionReason", "approvedBy", "actorUid"]) assert.equal(JSON.stringify(view).includes('"' + field + '"'), false);
  assert.equal(view.changeRequests[0].status, "Draft");
  assert.throws(() => rateUpdate({ mutationTotal: 2000 }));
  assert.throws(() => rateUpdate({ mutationMinuteStart: Date.now(), mutationMinuteCount: 30 }));
});
test("contract details calculate cancellation server-side and reject client attachment links", () => {
  const input = { name: "Maintenance", startDate: "2026-10-01", endDate: "2027-10-01", pricePerMonth: 12.50, terminationPeriodDays: 30, reminderDays: [30, 7], followers: [] };
  assert.equal(contractInput(input).cancelBefore, "2027-09-01");
  for (const patch of [{ downloadUrl: "https://example.test" }, { contractFiles: [] }, { endDate: "2027-02-30" }, { terminationPeriodDays: 1.5 }, { pricePerMonth: -1 }, { reminderDays: ["7"] }]) assert.throws(() => contractInput({ ...input, ...patch }));
});
test("contract attachments are scoped to their own hotel and contract and never expose tokens", () => {
  const files = filesOf({ contractFiles: [{ fileName: "contract.pdf", filePath: "hotels/hotel-a/contracts/contract-a/file.pdf", downloadUrl: "https://example.test/?token=fictional" }] }, "hotel-a", "contract-a");
  assert.equal(files.length, 1); assert.equal(files[0].downloadUrl, undefined);
  assert.throws(() => filesOf({ contractFiles: [{ fileName: "cross.pdf", filePath: "hotels/hotel-b/contracts/contract-a/file.pdf" }] }, "hotel-a", "contract-a"));
  assert.throws(() => filesOf({ contractFiles: [{ fileName: "cross.pdf", filePath: "hotels/hotel-a/contracts/contract-a/../file.pdf" }] }, "hotel-a", "contract-a"));
});
test("new backend exports load without extra secrets or parameters", () => {
  const exported = require("../index");
  for (const name of ["listHotelContracts", "saveHotelContract", "contractDocument", "getRoomingList", "mutateRoomingList", "reviewRoomingList"]) assert.equal(typeof exported[name], "function");
});
