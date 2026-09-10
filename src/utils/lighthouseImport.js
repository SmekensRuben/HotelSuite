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
  .replace(/\s+/g, " ")
  .trim()
  .toLowerCase();

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
  const headerRowIndex = rows.findIndex((row) => {
    const headers = new Set((row || []).map(normalizeHeader));
    return requiredHeaders.every((header) => headers.has(normalizeHeader(header)));
  });
  if (headerRowIndex < 0) {
    throw new Error(`De vereiste kolommen ontbreken: ${requiredHeaders.join(", ")}.`);
  }

  const headerRow = rows[headerRowIndex];
  const columnIndexes = Object.fromEntries(requiredHeaders.map((header) => [
    header,
    headerRow.findIndex((value) => normalizeHeader(value) === normalizeHeader(header)),
  ]));

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
