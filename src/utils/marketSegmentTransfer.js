const FILE_TYPE = "hotel-suite-market-segments";
const VERSION = 1;

const normalizePrefix = (item) => ({
  prefix: String(item?.prefix || "").trim(),
  name: String(item?.name || "").trim(),
  description: String(item?.description || "").trim(),
});

const normalizeMarketSegment = (item) => ({
  title: String(item?.title || "").trim(),
  prefixes: Array.isArray(item?.prefixes) ? item.prefixes.map(normalizePrefix) : [],
});

const isValidMarketSegment = (item) => item.title
  && item.prefixes.length > 0
  && item.prefixes.every(({ prefix, name, description }) => prefix && name && description && !prefix.includes("/"));

export function createMarketSegmentsExport(marketSegments) {
  return {
    fileType: FILE_TYPE,
    version: VERSION,
    marketSegments: marketSegments.map(normalizeMarketSegment),
  };
}

export function parseMarketSegmentsImport(contents) {
  let data;
  try {
    data = JSON.parse(contents);
  } catch {
    throw new Error("The selected file is not valid JSON.");
  }

  const marketSegments = Array.isArray(data?.marketSegments)
    ? data.marketSegments.map(normalizeMarketSegment)
    : [];
  if (data?.fileType !== FILE_TYPE || data?.version !== VERSION || marketSegments.length === 0 || !marketSegments.every(isValidMarketSegment)) {
    throw new Error("The selected file is not a valid Market Segments export.");
  }
  return marketSegments;
}
