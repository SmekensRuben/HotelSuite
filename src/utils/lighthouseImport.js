export const LIGHTHOUSE_FIELDS = [
  "My OTB",
  "Market demand",
  "Gent Marriott Hotel",
  "Pillows Grand Boutique Hotel Reylof Ghent",
  "NH Collection Gent",
  "Yalo Urban Boutique Hotel Gent",
  "Novotel Gent Centrum",
];

const normalizeHeader = (value) => String(value ?? "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]+/gi, " ")
  .replace(/\s+/g, " ")
  .trim()
  .toLowerCase();

const HEADER_MATCHERS = {
  Date: (header) => header === "date" || header === "day date",
  "My OTB": (header) => header === "my otb",
  "Market demand": (header) => header === "market demand",
  "Gent Marriott Hotel": (header) =>
    header.includes("marriott") && (header.includes("gent") || header.includes("ghent")),
  "Pillows Grand Boutique Hotel Reylof Ghent": (header) =>
    header.includes("pillows") && header.includes("reylof"),
  "NH Collection Gent": (header) =>
    header.includes("nh collection") && (header.includes("gent") || header.includes("ghent")),
  "Yalo Urban Boutique Hotel Gent": (header) => header.includes("yalo"),
  "Novotel Gent Centrum": (header) =>
    header.includes("novotel") && (header.includes("centrum") || header.includes("centre")),
};

const findColumnIndexes = (row, requiredHeaders) => {
  const normalizedCells = (row || []).map(normalizeHeader);
  return Object.fromEntries(requiredHeaders.map((header) => [
    header,
    normalizedCells.findIndex(HEADER_MATCHERS[header]),
  ]));
};

const toIsoDate = (value) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  const text = String(value ?? "").trim();
  const match = text.match(/(?:^|\s)(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\s|$)/);
  if (!match) return null;
  const [, day, month, year] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (
    date.getFullYear() !== Number(year)
    || date.getMonth() !== Number(month) - 1
    || date.getDate() !== Number(day)
  ) return null;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
};

export const getLocalIsoDate = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export function parseLighthouseRows(rows) {
  if (!Array.isArray(rows)) throw new Error("Het tabblad Rates kon niet gelezen worden.");

  const requiredHeaders = ["Date", ...LIGHTHOUSE_FIELDS];
  const headerCandidates = rows.map((row, index) => {
    const indexes = findColumnIndexes(row, requiredHeaders);
    const matchCount = Object.values(indexes).filter((columnIndex) => columnIndex >= 0).length;
    return { index, indexes, matchCount };
  });
  const bestHeader = headerCandidates.reduce(
    (best, candidate) => candidate.matchCount > best.matchCount ? candidate : best,
    { index: -1, indexes: {}, matchCount: 0 }
  );
  const headerRowIndex = bestHeader.index;
  const missingHeaders = requiredHeaders.filter((header) => bestHeader.indexes[header] < 0);
  if (missingHeaders.length) {
    throw new Error(`De vereiste kolommen ontbreken: ${missingHeaders.join(", ")}.`);
  }

  const columnIndexes = bestHeader.indexes;

  const importedRows = [];
  rows.slice(headerRowIndex + 1).forEach((row, offset) => {
    const dateValue = row?.[columnIndexes.Date];
    const hasRequiredData = LIGHTHOUSE_FIELDS.some((field) => String(row?.[columnIndexes[field]] ?? "").trim());
    if (!String(dateValue ?? "").trim() && !hasRequiredData) return;

    const stayDate = toIsoDate(dateValue);
    if (!stayDate) throw new Error(`Ongeldige datum op rij ${headerRowIndex + offset + 2}.`);

    const data = Object.fromEntries(LIGHTHOUSE_FIELDS.map((field) => [
      field,
      String(row?.[columnIndexes[field]] ?? "").trim(),
    ]));
    importedRows.push({ stayDate, data });
  });

  if (!importedRows.length) throw new Error("Het tabblad Rates bevat geen datarijen.");
  if (new Set(importedRows.map(({ stayDate }) => stayDate)).size !== importedRows.length) {
    throw new Error("Het tabblad Rates bevat dubbele datums.");
  }
  return importedRows;
}
