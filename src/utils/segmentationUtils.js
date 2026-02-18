export const normalizeMarketSegmentCode = (code) =>
  String(code || "").trim().toUpperCase();

export const getMarketSegmentCodes = (segment) => {
  if (!segment) return [];
  const codes = Array.isArray(segment.marketSegmentCodes)
    ? segment.marketSegmentCodes
    : segment.marketSegmentCode
      ? [segment.marketSegmentCode]
      : [];
  return codes
    .map((value) => String(value || "").trim())
    .filter(Boolean);
};

export const parseMarketSegmentCodesInput = (input) => {
  if (Array.isArray(input)) {
    return input.map((value) => String(value || "").trim()).filter(Boolean);
  }
  return String(input || "")
    .split(/[,;\n]+/)
    .map((value) => value.trim())
    .filter(Boolean);
};
