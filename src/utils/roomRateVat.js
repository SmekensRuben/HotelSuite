export const RATE_BASIS = Object.freeze({ EXCL_VAT: "EXCL_VAT", INCL_VAT: "INCL_VAT" });

export function normalizeRoomVatPercentage(value) {
  if (value === null || value === undefined || value === "") throw new Error("roomVatPercentage is required.");
  const percentage = Number(value);
  if (!Number.isFinite(percentage) || percentage < 0) throw new Error("roomVatPercentage must be zero or greater.");
  return percentage;
}

export function toRoomRateInclVat(rateExVat, roomVatPercentage) {
  if (rateExVat === null || rateExVat === undefined) return null;
  const rate = Number(rateExVat);
  if (!Number.isFinite(rate)) return null;
  return rate * (1 + normalizeRoomVatPercentage(roomVatPercentage) / 100);
}

export function toRoomRateExVat(rateInclVat, roomVatPercentage) {
  if (rateInclVat === null || rateInclVat === undefined) return null;
  const rate = Number(rateInclVat);
  if (!Number.isFinite(rate)) return null;
  return rate / (1 + normalizeRoomVatPercentage(roomVatPercentage) / 100);
}
