"use strict";

// Only verified CSV/XLSX product rows may be supplied by the caller. This is a
// deliberately small declaration parser, not an interpreter of document prose.
// Unknown labels, symbols, PDFs and unstructured text remain unknown for review.
const MAX_ROWS = 1000;
const MAX_COLUMNS = 128;
const MAX_TEXT = 1024 * 1024;
const SCALE = 1000000n;
const CURRENCIES = new Set(Intl.supportedValuesOf("currency"));
const FIELDS = ["currency", "priceBasis", "vatRate"];
const PRICE_WORDS = new Set(["price", "prices", "prijs", "prijzen", "prix", "tarief", "unitprice", "eenheidsprijs", "stukprijs", "aankoopprijs", "inkoopprijs"]);
const PRICE_TOKENS = new Set([...PRICE_WORDS, "unit", "unitaire", "purchase", "buying", "base", "package", "pack", "box", "bottle", "piece", "each", "per", "par", "g", "gr", "kg", "ml", "l",
  "net", "netto", "gross", "bruto", "incl", "including", "included", "inclusive", "inclusief", "excl", "excluding", "excluded", "exclusive", "exclusief", "hors", "without", "with", "vat", "btw", "tva", "tax", "taxes", "ht", "ttc", "at", "de", "of", "van"]);
const plain = (value) => String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
const label = (value) => plain(value).toLowerCase().replace(/_/g, " ").replace(/\.(?!\d)|(?<!\d)\./g, " ").replace(/\s+/g, " ").trim();
const empty = (value) => value === null || value === undefined || plain(value) === "";

function tablePosition(sourceId) {
  if (sourceId === "csv-header") return { sheet: "csv", row: 1 };
  const csv = /^csv-row-(\d{1,6})$/.exec(sourceId || "");
  if (csv) return { sheet: "csv", row: Number(csv[1]) };
  const xlsx = /^xlsx-sheet-(\d{1,3})-row-(\d{1,7})$/.exec(sourceId || "");
  return xlsx ? { sheet: `xlsx-${xlsx[1]}`, row: Number(xlsx[2]) } : null;
}

function cellsOf(unit) {
  if (!unit || typeof unit.text !== "string" || !tablePosition(unit.sourceId)) return null;
  let cells;
  try { cells = JSON.parse(unit.text); } catch { return null; }
  if (!Array.isArray(cells)) return null;
  if (cells.length > MAX_COLUMNS) throw new RangeError("Source declarations support at most 128 table columns.");
  return cells.every((cell) => cell === null || typeof cell === "string" || typeof cell === "boolean" || (typeof cell === "number" && Number.isFinite(cell))) ? cells : null;
}

function priceHeader(value) {
  const words = plain(value).match(/[\p{L}\d]+/gu) || [];
  return words.some((word) => PRICE_WORDS.has(word.toLowerCase())) && words.every((word) => PRICE_TOKENS.has(word.toLowerCase())
    // ISO codes inside price headers must be explicit uppercase labels. English
    // words such as "all" or "try" must not become ALL/TRY currency declarations.
    || CURRENCIES.has(word) || /^\d+$/.test(word));
}

function basisOf(value) {
  const text = label(value);
  const net = /\b(?:net|netto|ht)\b|\b(?:excl|excluding|excluded|exclusive|exclusief|hors|without)\s+(?:vat|btw|tva|tax|taxes)\b/.test(text);
  const gross = /\b(?:gross|bruto|ttc)\b|\b(?:incl|including|included|inclusive|inclusief|with)\s+(?:(?:\d+(?:[.,]\d+)?\s*%)\s*)?(?:vat|btw|tva|tax|taxes)\b/.test(text);
  return net && gross ? { ambiguous: true } : net ? { value: "net" } : gross ? { value: "gross" } : null;
}

function vatHeader(value) {
  const text = label(value).replace(/[()%]/g, " ").replace(/\s+/g, " ").trim();
  if (!/^(?:(?:vat|btw|tva)(?: rate| tarief| percentage| percent| fraction| decimal fraction| as fraction)?|tax rate)(?: percentage| percent| fraction| decimal fraction| as fraction)?$/.test(text)) return null;
  const original = label(value);
  const percent = /%|\b(?:percentage|percent)\b/.test(original);
  const fraction = /\bfraction\b/.test(original);
  return { percent, fraction, ambiguous: percent && fraction };
}

// Establish a six-decimal VAT fraction from decimal spelling using integers.
// This avoids 5.6 / 100 producing an inexact financial-contract value.
function vatOf(value, mode) {
  const spelling = plain(value), match = /^(\d+)(?:[.,](\d+))?\s*(%)?$/.exec(spelling);
  if (!match || spelling.length > 80 || mode?.ambiguous) return { ambiguous: true };
  const explicitPercent = Boolean(match[3]), percent = explicitPercent || mode?.percent;
  if (explicitPercent && mode?.fraction) return { ambiguous: true };
  if (!percent && !mode?.fraction) return { ambiguous: true };
  const digits = BigInt(match[1] + (match[2] || "")), places = (match[2] || "").length + (percent ? 2 : 0);
  let scaled;
  if (places <= 6) scaled = digits * (10n ** BigInt(6 - places));
  else {
    const divisor = 10n ** BigInt(places - 6);
    if (digits % divisor !== 0n) return { ambiguous: true };
    scaled = digits / divisor;
  }
  return scaled <= SCALE ? { value: Number(scaled) / Number(SCALE) } : { ambiguous: true };
}

function supplierAiSourceDeclarations({ rows = [], headers = [] } = {}) {
  if (!Array.isArray(rows) || !Array.isArray(headers)) throw new TypeError("Source declaration rows and headers must be arrays.");
  if (rows.length > MAX_ROWS || headers.length > MAX_ROWS) throw new RangeError("Source declarations support at most 1,000 rows and 1,000 headers.");
  let size = 0;
  for (const unit of [...rows, ...headers]) {
    size += typeof unit?.text === "string" ? Buffer.byteLength(unit.text) : 0;
    if (size > MAX_TEXT) throw new RangeError("Source declarations exceed the bounded source text limit.");
  }
  const declarations = Object.fromEntries(FIELDS.map((field) => [field, new Set()])), ambiguous = new Set(), sourceIds = new Set();
  const offer = (field, declaration, sourceId) => {
    if (!declaration) return;
    if (declaration.ambiguous) ambiguous.add(field);
    else declarations[field].add(declaration.value);
    sourceIds.add(sourceId);
  };
  const parsedHeaders = headers.map((unit) => ({ position: tablePosition(unit?.sourceId), cells: cellsOf(unit) })).filter((header) => header.position && header.cells);
  for (const row of rows) {
    if (row?.contextOnly === true) continue;
    const position = tablePosition(row?.sourceId), cells = cellsOf(row);
    if (!position || !cells) continue;
    const candidates = parsedHeaders.filter((header) => header.position.sheet === position.sheet && header.position.row < position.row);
    const nearest = candidates.reduce((maximum, header) => Math.max(maximum, header.position.row), 0);
    for (const header of candidates.filter((item) => item.position.row === nearest)) {
      for (let index = 0; index < Math.min(cells.length, header.cells.length); index++) {
        const heading = label(header.cells[index]), value = cells[index];
        if (/^(?:currency|valuta|devise|munt)(?: code| iso| iso code| \(iso\)| \(iso code\))?$|^iso currency(?: code)?$/.test(heading) && !empty(value)) {
          const currency = plain(value).toUpperCase();
          offer("currency", CURRENCIES.has(currency) ? { value: currency } : { ambiguous: true }, row.sourceId);
        }
        if (/^(?:price basis|prijsbasis|tax basis|vat basis)$/.test(heading) && !empty(value)) {
          const normalized = label(value);
          const safe = /^(?:net|netto|gross|bruto|ht|ttc|(?:incl|including|included|inclusive|inclusief|excl|excluding|excluded|exclusive|exclusief|hors|without|with)\s+(?:vat|btw|tva|tax|taxes))$/.test(normalized);
          offer("priceBasis", safe ? basisOf(normalized) || { ambiguous: true } : { ambiguous: true }, row.sourceId);
        }
        const tax = vatHeader(heading);
        if (tax && !empty(value)) offer("vatRate", vatOf(value, tax), row.sourceId);
        if (priceHeader(header.cells[index])) {
          const currencies = (plain(header.cells[index]).match(/\b[A-Z]{3}\b/g) || []).filter((code) => CURRENCIES.has(code));
          for (const currency of currencies) offer("currency", { value: currency }, row.sourceId);
          offer("priceBasis", basisOf(heading), row.sourceId);
          for (const match of heading.matchAll(/\b(?:vat|btw|tva)\s*(?:at\s*)?(\d+(?:[.,]\d+)?)\s*%|\b(\d+(?:[.,]\d+)?)\s*%\s*(?:vat|btw|tva)\b/g)) {
            offer("vatRate", vatOf(`${match[1] || match[2]}%`, { percent: true }), row.sourceId);
          }
        }
      }
    }
  }
  const result = { currency: null, priceBasis: null, vatRate: null, ambiguousFields: [], sourceIds: [...sourceIds].sort() };
  for (const field of FIELDS) {
    if (declarations[field].size > 1) ambiguous.add(field);
    if (ambiguous.has(field)) result.ambiguousFields.push(field);
    else if (declarations[field].size === 1) result[field] = [...declarations[field]][0];
  }
  return result;
}

module.exports = { supplierAiSourceDeclarations };
