"use strict";

// Uploaded documents are evidence, never instructions or executable content.
// This module performs no network requests, authentication or database writes.
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { Worker } = require("node:worker_threads");
const { parse: parseCsv } = require("csv-parse/sync");
const ExcelJS = require("exceljs");
const sax = require("sax");

const LIMITS = Object.freeze({
  sourceBytes: 10 * 1024 * 1024,
  textBytes: 1024 * 1024,
  unitCharacters: 32768,
  cellCharacters: 8192,
  columns: 128,
  rows: 1000,
  units: 5000,
  sheets: 32,
  zipEntries: 512,
  zipEntryBytes: 8 * 1024 * 1024,
  zipExpandedBytes: 32 * 1024 * 1024,
  zipRatio: 1000,
  xmlDepth: 64,
  pdfPages: 50,
  pdfWorkerMs: 10000,
  mimeParts: 100,
  mimeDepth: 8,
});

const TYPES = Object.freeze({
  csv: ["text/csv", "application/csv", "application/vnd.ms-excel", "text/plain"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  pdf: ["application/pdf"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  eml: ["message/rfc822", "text/plain"],
  txt: ["text/plain"],
});

class SupplierAiExtractionError extends Error {
  constructor(code, message) { super(message); this.name = "SupplierAiExtractionError"; this.code = code; }
}
function fail(code, message) { throw new SupplierAiExtractionError(code, message); }

function decodedText(bytes, charset = "utf-8") {
  let value;
  try { value = new TextDecoder(charset, { fatal: true }).decode(bytes); }
  catch { fail("INVALID_TEXT_ENCODING", "The source contains unsupported or invalid text encoding."); }
  if (value.includes("\0")) fail("BINARY_TEXT", "A text source contains binary data.");
  return value.replace(/^\uFEFF/, "");
}
function inputText(bytes) {
  const charset = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
    : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  const text = decodedText(bytes, charset);
  if (Buffer.byteLength(text) > LIMITS.textBytes) fail("TEXT_LIMIT", "The extracted text exceeds 1 MiB; split the source into smaller imports.");
  return text;
}

function collector() {
  const units = [];
  const warnings = [];
  let size = 0;
  return {
    units, warnings,
    add(sourceId, anchor, text) {
      if (!text.trim()) return;
      if (text.length > LIMITS.unitCharacters) fail("UNIT_LIMIT", "A source row or paragraph is too large; split the source.");
      size += Buffer.byteLength(text) + Buffer.byteLength(sourceId) + Buffer.byteLength(anchor);
      if (size > LIMITS.textBytes || units.length >= LIMITS.units) fail("TEXT_LIMIT", "The extracted source exceeds the text or unit limit; split the source.");
      units.push({ sourceId, anchor, text });
    },
    warn(code, message, sourceId) {
      if (!warnings.some((warning) => warning.code === code && warning.sourceId === sourceId)) {
        warnings.push({ code, message, ...(sourceId ? { sourceId } : {}) });
      }
    },
  };
}

function cellsText(values) {
  if (values.length > LIMITS.columns) fail("COLUMN_LIMIT", "The source has more than 128 columns.");
  for (const value of values) if (String(value ?? "").length > LIMITS.cellCharacters) fail("CELL_LIMIT", "A source cell exceeds 8,192 characters.");
  // JSON quoting prevents cell values from becoming delimiters or source anchors.
  return JSON.stringify(values);
}

function extractCsv(bytes, result) {
  const text = inputText(bytes);
  let chosen;
  for (const delimiter of [",", ";", "\t", "|"]) {
    try {
      const sample = parseCsv(text, { delimiter, bom: true, skip_empty_lines: true, relax_column_count: true, to: 30, max_record_size: LIMITS.unitCharacters });
      if (!sample.length) continue;
      const widths = sample.map((row) => row.length);
      const modal = [...new Set(widths)].map((width) => ({ width, count: widths.filter((item) => item === width).length }))
        .sort((a, b) => b.count - a.count || b.width - a.width)[0];
      const score = modal.width > 1 ? modal.count / sample.length * 100 + Math.min(modal.width, 20) : 0;
      if (!chosen || score > chosen.score) chosen = { delimiter, score };
    } catch { /* Try other known delimiters; the full strict parse below reports failure. */ }
  }
  let records;
  try {
    records = parseCsv(text, { delimiter: chosen?.delimiter || ",", bom: true, skip_empty_lines: true,
      relax_column_count: true, max_record_size: LIMITS.unitCharacters, info: true });
  } catch { fail("INVALID_CSV", "The CSV contains invalid quoting or an oversized record."); }
  if (!records.length) fail("EMPTY_SOURCE", "The source contains no nonempty rows.");
  if (records.length > LIMITS.rows + 1) fail("ROW_LIMIT", "The source exceeds 1,000 product rows plus one header; split the source.");
  const header = records[0].record;
  result.add("csv-header", "CSV record 1 (possible header)", cellsText(header));
  records.slice(1).forEach(({ record, info }, index) => result.add(`csv-row-${index + 2}`, `CSV record ${index + 2}, ending at line ${info.lines}`, cellsText(record)));
  result.warn("HEADER_REVIEW", "The first CSV row is supplied as possible header context. Review any first-row product that lacks a header.");
}

// Validate the complete ZIP and inflate every member under bounds before handing
// it to a general Office parser. Central-directory sizes alone are not trusted.
function boundedZip(bytes) {
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50 && index + 22 + bytes.readUInt16LE(index + 20) === bytes.length) { end = index; break; }
  }
  if (end < 0) fail("INVALID_ARCHIVE", "The Office file has an invalid ZIP directory.");
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryStart = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count
    || count === 0xffff || directoryStart === 0xffffffff || directorySize === 0xffffffff) fail("UNSUPPORTED_ARCHIVE", "Split, encrypted or ZIP64 Office archives are not supported.");
  if (!count || count > LIMITS.zipEntries || directoryStart + directorySize !== end) fail("ARCHIVE_LIMIT", "The Office archive exceeds the directory limit or is malformed.");
  const members = new Map();
  const spans = [];
  let cursor = directoryStart;
  let total = 0;
  for (let entry = 0; entry < count; entry += 1) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) fail("INVALID_ARCHIVE", "The Office ZIP directory is corrupt.");
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const expandedSize = bytes.readUInt32LE(cursor + 24);
    const nameSize = bytes.readUInt16LE(cursor + 28);
    const extraSize = bytes.readUInt16LE(cursor + 30);
    const commentSize = bytes.readUInt16LE(cursor + 32);
    const attributes = bytes.readUInt32LE(cursor + 38);
    const offset = bytes.readUInt32LE(cursor + 42);
    if (cursor + 46 + nameSize + extraSize + commentSize > end) fail("INVALID_ARCHIVE", "The Office archive entry is truncated.");
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameSize);
    const name = decodedText(nameBytes);
    if (!name || name.length > 256 || name.includes("\\") || name.startsWith("/") || name.split("/").some((part) => part === "." || part === "..")
      || /[\u0000-\u001f]/.test(name) || members.has(name) || (attributes >>> 16 & 0xf000) === 0xa000) fail("UNSAFE_ARCHIVE", "The Office archive contains unsafe or duplicate paths.");
    if (flags & 0x2041 || ![0, 8].includes(method) || expandedSize === 0xffffffff || compressedSize === 0xffffffff || offset === 0xffffffff) fail("UNSUPPORTED_ARCHIVE", "Encrypted or unsupported Office archives are not supported.");
    if (expandedSize > LIMITS.zipEntryBytes || (expandedSize > 1024 * 1024 && expandedSize > Math.max(1, compressedSize) * LIMITS.zipRatio)) fail("ARCHIVE_LIMIT", "An Office archive member exceeds the expansion limit.");
    if (/vbaProject|(?:^|\/)embeddings\/|(?:^|\/)activeX\/|\.bin$/i.test(name)) fail("ACTIVE_CONTENT", "Office macros, embedded objects and ActiveX are not supported.");
    if (offset + 30 > directoryStart || bytes.readUInt32LE(offset) !== 0x04034b50) fail("INVALID_ARCHIVE", "An Office archive local header is invalid.");
    const localNameSize = bytes.readUInt16LE(offset + 26);
    const localExtraSize = bytes.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + localNameSize + localExtraSize;
    if (dataStart + compressedSize > directoryStart || !bytes.subarray(offset + 30, offset + 30 + localNameSize).equals(nameBytes)
      || bytes.readUInt16LE(offset + 6) !== flags || bytes.readUInt16LE(offset + 8) !== method) fail("INVALID_ARCHIVE", "The Office archive member disagrees with its directory.");
    let memberEnd = dataStart + compressedSize;
    if (flags & 8) {
      if (memberEnd + 12 > directoryStart) fail("INVALID_ARCHIVE", "The Office archive data descriptor is incomplete.");
      const descriptorStart = bytes.readUInt32LE(memberEnd) === 0x08074b50 ? memberEnd + 4 : memberEnd;
      if (descriptorStart + 12 > directoryStart || bytes.readUInt32LE(descriptorStart) !== crc
        || bytes.readUInt32LE(descriptorStart + 4) !== compressedSize || bytes.readUInt32LE(descriptorStart + 8) !== expandedSize)
        fail("INVALID_ARCHIVE", "An Office archive data descriptor disagrees with its directory.");
      memberEnd = descriptorStart + 12;
    } else if (bytes.readUInt32LE(offset + 14) !== crc || bytes.readUInt32LE(offset + 18) !== compressedSize || bytes.readUInt32LE(offset + 22) !== expandedSize)
      fail("INVALID_ARCHIVE", "An Office archive local size or checksum disagrees with its directory.");
    if (spans.some(([start, finish]) => offset < finish && memberEnd > start)) fail("INVALID_ARCHIVE", "The Office archive has overlapping members.");
    spans.push([offset, memberEnd]);
    let body;
    try { body = method === 0 ? Buffer.from(bytes.subarray(dataStart, dataStart + compressedSize))
      : zlib.inflateRawSync(bytes.subarray(dataStart, dataStart + compressedSize), { maxOutputLength: LIMITS.zipEntryBytes }); }
    catch { fail("ARCHIVE_LIMIT", "An Office member is corrupt or exceeds the decompression limit."); }
    if (body.length !== expandedSize || crc32(body) !== crc) fail("INVALID_ARCHIVE", "An Office archive member failed its size or checksum validation.");
    total += body.length;
    if (total > LIMITS.zipExpandedBytes) fail("ARCHIVE_LIMIT", "The Office archive exceeds 32 MiB of decompressed content.");
    members.set(name, body);
    cursor += 46 + nameSize + extraSize + commentSize;
  }
  if (cursor !== end || !members.has("[Content_Types].xml")) fail("INVALID_ARCHIVE", "The Office archive directory or content type is incomplete.");
  // Streaming Office parsers read local entries as well as the central list.
  // Reject any gap/unlisted entry instead of permitting a hidden member bomb.
  let covered = 0;
  for (const [start, finish] of spans.sort((a, b) => a[0] - b[0])) {
    if (start !== covered) fail("INVALID_ARCHIVE", "The Office archive contains unlisted or padded local content.");
    covered = finish;
  }
  if (covered !== directoryStart) fail("INVALID_ARCHIVE", "The Office archive contains unlisted local entries.");
  for (const [name, body] of members) if (/\.xml$|\.rels$/i.test(name)) validateXml(body);
  if (/macroEnabled|vbaProject|oleObject|activeX/i.test(decodedText(members.get("[Content_Types].xml")))) fail("ACTIVE_CONTENT", "Office macros or embedded objects are not supported.");
  return members;
}

let crcTable;
function crc32(bytes) {
  crcTable ||= Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
    return value >>> 0;
  });
  let crc = 0xffffffff;
  for (const value of bytes) crc = crcTable[(crc ^ value) & 255] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}

function xmlParser(bytes, handlers = {}) {
  const text = decodedText(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) fail("ACTIVE_CONTENT", "XML document types and entities are not supported.");
  const parser = sax.parser(true, { trim: false, normalize: false, xmlns: false });
  let depth = 0;
  let nodes = 0;
  parser.onerror = () => fail("INVALID_XML", "The Office XML is malformed.");
  parser.onopentag = (node) => {
    depth += 1;
    nodes += 1;
    if (depth > LIMITS.xmlDepth || nodes > 100000 || Object.keys(node.attributes).length > 64
      || Object.values(node.attributes).some((value) => String(value).length > 4096)) fail("XML_LIMIT", "The Office XML exceeds structural limits.");
    handlers.open?.(node);
  };
  parser.onclosetag = (name) => { handlers.close?.(name); depth -= 1; };
  parser.ontext = (textValue) => handlers.text?.(textValue);
  parser.oncdata = (textValue) => handlers.text?.(textValue);
  parser.write(text).close();
}
function validateXml(bytes) { xmlParser(bytes); }

async function extractXlsx(bytes, members, result) {
  if (!members.has("xl/workbook.xml") || members.has("word/document.xml")) fail("TYPE_MISMATCH", "The uploaded file is not an XLSX workbook.");
  let physicalRows = 0;
  let worksheetCount = 0;
  xmlParser(members.get("xl/workbook.xml"), { open(node) {
    if (node.name === "sheet" && ++worksheetCount > LIMITS.sheets) fail("SHEET_LIMIT", "The workbook exceeds 32 worksheets.");
  } });
  let metadataCells = 0;
  const checkRange = (reference) => {
    const match = String(reference).match(/^\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/);
    const column = (letters) => [...letters].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0);
    if (!match) fail("WORKBOOK_RANGE_LIMIT", "A workbook metadata range is invalid.");
    const fromColumn = column(match[1]); const toColumn = column(match[3] || match[1]);
    const fromRow = Number(match[2]); const toRow = Number(match[4] || match[2]);
    if (fromColumn < 1 || toColumn < fromColumn || toColumn > LIMITS.columns || fromRow < 1 || toRow < fromRow || toRow > 10000)
      fail("WORKBOOK_RANGE_LIMIT", "Workbook metadata refers to an excessive row or column range; remove unused formatting and validation ranges.");
    metadataCells += (toColumn - fromColumn + 1) * (toRow - fromRow + 1);
    if (metadataCells > 32768) fail("WORKBOOK_RANGE_LIMIT", "Workbook metadata expands to too many cells; remove unused formatting or validation ranges.");
  };
  for (const [name, body] of members) {
    if (/^xl\/worksheets\/[^/]+\.xml$/.test(name)) xmlParser(body, { open(node) {
      if (node.name === "row") {
        physicalRows += 1;
        if (physicalRows > LIMITS.rows + LIMITS.sheets || !/^\d+$/.test(String(node.attributes.r || "")) || Number(node.attributes.r) > 10000) fail("ROW_LIMIT", "The workbook exceeds the row or row-index limit; split it into smaller imports.");
      }
      if (node.name === "c") {
        const match = String(node.attributes.r || "").match(/^([A-Z]{1,3})(\d+)$/);
        const column = match && [...match[1]].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0);
        if (!column || column > LIMITS.columns || Number(match[2]) > 10000) fail("COLUMN_LIMIT", "The workbook contains out-of-range cell references.");
      }
      if (node.name === "mergeCell") checkRange(node.attributes.ref);
      if (node.name === "dataValidation" || node.name === "conditionalFormatting") {
        const ranges = String(node.attributes.sqref || "").split(/\s+/).filter(Boolean);
        if (!ranges.length || ranges.length > 128) fail("WORKBOOK_RANGE_LIMIT", "Workbook validation metadata has an excessive or invalid range list.");
        ranges.forEach(checkRange);
      }
      if (node.name === "col") {
        const min = Number(node.attributes.min); const max = Number(node.attributes.max);
        if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > LIMITS.columns) fail("WORKBOOK_RANGE_LIMIT", "Workbook column metadata exceeds 128 columns.");
      }
    } });
    if (/^xl\/media\//.test(name)) result.warn("WORKBOOK_IMAGES_IGNORED", "Workbook images are not interpreted. Upload a PDF or document separately if the images contain product data.");
  }
  const parsed = await boundedWorkbook(bytes);
  parsed.units.forEach((unit) => {
    result.add(unit.sourceId, unit.anchor, unit.text);
    Object.assign(result.units.at(-1), { sheetName: unit.sheetName,
      ...(unit.uncertainColumns?.length ? { uncertainColumns: unit.uncertainColumns } : {}) });
  });
  parsed.warnings.forEach((warning) => result.warn(warning.code, warning.message, warning.sourceId));
}

async function parseWorkbookForWorker(bytes) {
  const result = collector();
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(bytes, { ignoreNodes: ["mergeCells", "dataValidations", "conditionalFormatting", "drawing", "extLst", "tableParts"] }); }
  catch { fail("INVALID_XLSX", "The workbook could not be parsed."); }
  if (!workbook.worksheets.length || workbook.worksheets.length > LIMITS.sheets) fail("SHEET_LIMIT", "The workbook must contain between 1 and 32 worksheets.");
  let rows = 0;
  workbook.worksheets.forEach((sheet, sheetIndex) => {
    let ordinal = 0;
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      ordinal += 1;
      if (ordinal > 1) rows += 1;
      if (rows > LIMITS.rows) fail("ROW_LIMIT", "The workbook exceeds 1,000 data rows across its worksheets; split it.");
      const values = [];
      const uncertainColumns = [];
      for (let column = 1; column <= row.cellCount; column += 1) {
        if (column > LIMITS.columns) fail("COLUMN_LIMIT", "The workbook contains more than 128 columns.");
        const cell = row.getCell(column);
        let value = cell.value;
        if (value instanceof Date) value = value.toISOString();
        else if (value && typeof value === "object") {
          if ("formula" in value || "sharedFormula" in value) {
            uncertainColumns.push(column - 1);
            result.warn("CACHED_FORMULAS", "Formulas are never executed. Their cached values may be stale; review affected prices and quantities.");
            value = value.result ?? null;
            if (value instanceof Date) value = value.toISOString();
          } else if (Array.isArray(value.richText)) value = value.richText.map((run) => run.text).join("");
          else if (typeof value.text === "string") value = value.text;
          else if (value.error) value = `[Spreadsheet error: ${value.error}]`;
          else fail("UNSUPPORTED_CELL", "The workbook contains an unsupported cell value.");
        }
        if (typeof value === "number" && Number.isInteger(value) && value >= 0 && /^0{2,32}$/.test(cell.numFmt || "")) {
          value = String(value).padStart(cell.numFmt.length, "0");
          result.warn("FORMATTED_NUMERIC_IDENTIFIER", "Numeric cells displayed with leading zeroes are preserved as displayed text; verify identifier columns.");
        }
        values.push(value ?? "");
      }
      const sourceId = `xlsx-sheet-${sheetIndex + 1}-row-${rowNumber}`;
      const context = ordinal === 1 ? " (possible header)" : "";
      result.add(sourceId, `Worksheet ${sheetIndex + 1} ${JSON.stringify(sheet.name)}, row ${rowNumber}${context}`, cellsText(values));
      Object.assign(result.units.at(-1), { sheetName: sheet.name, ...(uncertainColumns.length ? { uncertainColumns } : {}) });
      if (row.hidden || sheet.state !== "visible") result.warn("HIDDEN_ROWS_INCLUDED", "Hidden worksheets and rows are included in the review; they are not silently skipped.");
    });
  });
  if (!result.units.length) fail("EMPTY_SOURCE", "The workbook contains no nonempty rows.");
  result.warn("HEADER_REVIEW", "The first nonempty row of each worksheet is supplied as possible header context. Review first-row products in sheets without headers.");
  return { units: result.units, warnings: result.warnings };
}

async function boundedWorkbook(bytes) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
      (async()=>{try{const result=await require(workerData.modulePath).__parseWorkbookForWorker(Buffer.from(workerData.bytes));
      parentPort.postMessage({result});}catch(error){parentPort.postMessage({error:{code:error.code||'INVALID_XLSX',message:error.message||'Workbook parsing failed.'}});}})();`, {
      eval: true, workerData: { modulePath: __filename, bytes },
      resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); worker.terminate().catch(() => {});
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new SupplierAiExtractionError("WORKBOOK_LIMIT", "Workbook parsing exceeded its resource limit; split or recreate the workbook.")), LIMITS.pdfWorkerMs);
    worker.once("message", (message) => message.error ? finish(new SupplierAiExtractionError(message.error.code, message.error.message)) : finish(null, message.result));
    worker.once("error", () => finish(new SupplierAiExtractionError("WORKBOOK_LIMIT", "Workbook parsing failed or exceeded its resource limit.")));
    worker.once("exit", () => { if (!settled) finish(new SupplierAiExtractionError("INVALID_XLSX", "Workbook parsing did not complete.")); });
  });
}

function extractDocx(members, result) {
  if (!members.has("word/document.xml") || members.has("xl/workbook.xml")) fail("TYPE_MISMATCH", "The uploaded file is not a DOCX document.");
  for (const [name] of members) if (/^word\/media\//.test(name)) result.warn("DOCUMENT_IMAGES_IGNORED", "DOCX images are not interpreted. If they contain product information, upload the original PDF or image-containing PDF separately.");
  const parts = [...members.keys()].filter((name) => /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/.test(name))
    .sort((a, b) => a === "word/document.xml" ? -1 : b === "word/document.xml" ? 1 : a.localeCompare(b));
  parts.forEach((part, partIndex) => {
    let paragraph = 0;
    let buffer = "";
    let inParagraph = false;
    let inText = false;
    let table = 0;
    let row = 0;
    xmlParser(members.get(part), {
      open(node) {
        const name = node.name.split(":").pop();
        if (name === "tbl") { table += 1; row = 0; }
        if (name === "tr") row += 1;
        if (name === "p") {
          if (inParagraph) fail("UNSUPPORTED_DOCX", "Nested document text boxes are not supported; upload a PDF instead.");
          paragraph += 1; buffer = ""; inParagraph = true;
        }
        if (inParagraph && name === "t") inText = true;
        if (inParagraph && name === "tab") buffer += "\t";
        if (inParagraph && ["br", "cr"].includes(name)) buffer += "\n";
        if (["altChunk", "object"].includes(name)) fail("ACTIVE_CONTENT", "DOCX embedded documents and objects are not supported.");
      },
      text(value) { if (inParagraph && inText) { buffer += value; if (buffer.length > LIMITS.unitCharacters) fail("UNIT_LIMIT", "A document paragraph is too large."); } },
      close(name) {
        const local = name.split(":").pop();
        if (local === "t") inText = false;
        if (local === "p") {
          result.add(`docx-part-${partIndex + 1}-paragraph-${paragraph}`, `${part}, paragraph ${paragraph}${row ? `, table ${table} row ${row}` : ""}`, buffer);
          inParagraph = false;
        }
        if (local === "tbl") row = 0;
      },
    });
  });
  if (!result.units.length) fail("EMPTY_SOURCE", "The document contains no supported textual content.");
}

function mailHeaders(text) {
  const split = /\r?\n\r?\n/.exec(text);
  if (!split || split.index > 65536) fail("INVALID_MAIL", "The email is missing valid bounded MIME headers.");
  const lines = text.slice(0, split.index).replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/);
  if (lines.length > 128) fail("MAIL_LIMIT", "The email contains too many headers.");
  const headers = new Map();
  for (const line of lines) {
    const match = line.match(/^([A-Za-z0-9-]+):[ \t]*(.*)$/);
    if (!match) fail("INVALID_MAIL", "The email contains malformed headers.");
    const key = match[1].toLowerCase();
    if (headers.has(key) && ["content-type", "content-transfer-encoding", "content-disposition"].includes(key)) fail("INVALID_MAIL", "The email contains duplicate MIME headers.");
    headers.set(key, match[2]);
  }
  return { headers, body: text.slice(split.index + split[0].length) };
}
function mimeParameter(value, name) {
  const match = String(value).match(new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"\\r\\n]*)"|([^;\\s]+))`, "i"));
  return match ? match[1] ?? match[2] : null;
}
function mailBodyBytes(body, encoding) {
  if (encoding === "base64") {
    const compact = body.replace(/[\r\n\t ]/g, "");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) fail("INVALID_MAIL", "The email contains invalid base64 content.");
    return Buffer.from(compact, "base64");
  }
  if (encoding === "quoted-printable") {
    const unfolded = body.replace(/=\r?\n/g, "");
    const output = [];
    for (let index = 0; index < unfolded.length; index += 1) {
      if (unfolded[index] === "=") {
        if (!/^[0-9a-f]{2}$/i.test(unfolded.slice(index + 1, index + 3))) fail("INVALID_MAIL", "The email contains invalid quoted-printable content.");
        output.push(parseInt(unfolded.slice(index + 1, index + 3), 16)); index += 2;
      } else output.push(unfolded.charCodeAt(index));
    }
    return Buffer.from(output);
  }
  if (!["7bit", "8bit", "binary", ""].includes(encoding)) fail("INVALID_MAIL", "The email uses an unsupported transfer encoding.");
  return Buffer.from(body, "latin1");
}
function htmlMailText(html) {
  // A read-only plain-text representation; no browser/DOM or resource fetching.
  // One forward scan, including malformed/unclosed tags. Never rescan the same
  // suffix for each '<' (which makes regex removal quadratic on hostile mail).
  const lower = html.toLowerCase();
  const output = [];
  let cursor = 0;
  let tokens = 0;
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start < 0) { output.push(html.slice(cursor)); break; }
    output.push(html.slice(cursor, start));
    let end = start + 1;
    let quote = null;
    while (end < html.length) {
      const character = html[end];
      if (quote) { if (character === quote) quote = null; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
      end += 1;
      if (end - start > 8192) fail("MAIL_LIMIT", "An email HTML tag exceeds its parsing limit.");
    }
    if (end >= html.length) { output.push(html.slice(start)); break; }
    if (++tokens > 50000) fail("MAIL_LIMIT", "The email HTML exceeds its token limit.");
    const tag = html.slice(start + 1, end).trim();
    const match = tag.match(/^(\/)?\s*([a-z][a-z0-9:-]*)/i);
    const closing = Boolean(match?.[1]);
    const name = match?.[2].toLowerCase();
    cursor = end + 1;
    if (!closing && ["script", "style"].includes(name)) {
      const close = lower.indexOf(`</${name}`, cursor);
      if (close < 0) break;
      cursor = close;
    } else if (name === "br" || closing && ["p", "div", "tr", "li"].includes(name)) output.push("\n");
    else if (closing && ["td", "th"].includes(name)) output.push("\t");
  }
  return output.join("").replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d{1,7}|#x[0-9a-f]{1,6});/gi, (entity) => {
    const named = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " }[entity.toLowerCase()];
    if (named) return named;
    const number = parseInt(entity.slice(entity[2].toLowerCase() === "x" ? 3 : 2, -1), entity[2].toLowerCase() === "x" ? 16 : 10);
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : "�";
  });
}
function extractEml(bytes, result) {
  // latin1 preserves bytes until each MIME part declares its own charset.
  const raw = bytes.toString("latin1");
  const topHeaders = mailHeaders(raw).headers;
  const subject = topHeaders.get("subject");
  if (subject) {
    const decodedSubject = subject.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, charset, encoding, content) =>
      decodedText(mailBodyBytes(encoding.toLowerCase() === "q" ? content.replace(/_/g, " ") : content,
        encoding.toLowerCase() === "q" ? "quoted-printable" : "base64"), charset));
    result.add("eml-subject", "Email subject", decodedSubject);
  }
  let partCount = 0;
  let attachmentCount = 0;
  const visit = (text, depth, path) => {
    partCount += 1;
    if (partCount > LIMITS.mimeParts || depth > LIMITS.mimeDepth) fail("MAIL_LIMIT", "The email exceeds its MIME part or nesting limit.");
    const { headers, body } = mailHeaders(text);
    const fullType = headers.get("content-type") || "text/plain; charset=us-ascii";
    const type = fullType.split(";")[0].trim().toLowerCase();
    const disposition = headers.get("content-disposition") || "";
    if (/^attachment\b/i.test(disposition) || mimeParameter(disposition, "filename") || mimeParameter(fullType, "name")) { attachmentCount += 1; return []; }
    if (type.startsWith("multipart/")) {
      const boundary = mimeParameter(fullType, "boundary");
      if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary)) fail("INVALID_MAIL", "The email has an invalid MIME boundary.");
      const lines = body.split(/\r?\n/);
      const parts = [];
      let current = null;
      let closed = false;
      for (const line of lines) {
        if (line === `--${boundary}` || line === `--${boundary}--`) {
          if (current) parts.push(current.join("\r\n"));
          current = [];
          if (line === `--${boundary}--`) { closed = true; break; }
        } else if (current) current.push(line);
      }
      if (!closed || !parts.length) fail("INVALID_MAIL", "The email multipart body is incomplete.");
      const descendants = parts.flatMap((part, index) => visit(part, depth + 1, `${path}-${index + 1}`));
      if (type === "multipart/alternative") {
        const plain = descendants.filter((part) => part.type === "text/plain");
        if (plain.length) return plain;
      }
      return descendants;
    }
    if (!["text/plain", "text/html"].includes(type)) { attachmentCount += 1; return []; }
    const decoded = mailBodyBytes(body, (headers.get("content-transfer-encoding") || "").trim().toLowerCase());
    if (decoded.length > LIMITS.textBytes) fail("TEXT_LIMIT", "The email body exceeds 1 MiB; split it.");
    const textValue = decodedText(decoded, mimeParameter(fullType, "charset") || "utf-8");
    return [{ type, path, text: type === "text/html" ? htmlMailText(textValue) : textValue }];
  };
  const parts = visit(raw, 0, "1");
  for (const part of parts) {
    part.text.split(/\r\n|\n|\r/).forEach((line, index) => result.add(`eml-part-${part.path}-line-${index + 1}`, `Email body part ${part.path}, line ${index + 1}`, line));
    if (part.type === "text/html") result.warn("HTML_MAIL_TEXT", "Email HTML was converted to plain text without executing scripts or fetching resources. Check table structure in the review.");
  }
  if (attachmentCount) result.warn("MAIL_ATTACHMENTS_IGNORED", `${attachmentCount} email attachment(s) or non-text inline parts were not imported. Upload each relevant attachment separately.`);
  if (!result.units.length) fail("EMPTY_SOURCE", "The email has no supported body text. Upload relevant attachments separately.");
}

async function pdfPageCount(bytes) {
  // pdf-lib can inflate PDF object streams: isolate its parser heap and deadline.
  // Only the page count crosses the worker boundary, never document objects.
  return new Promise((resolve, reject) => {
    const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
      (async()=>{try{const {PDFDocument}=require(workerData.modulePath);
      const doc=await PDFDocument.load(workerData.bytes,{ignoreEncryption:false,updateMetadata:false,throwOnInvalidObject:true});
      parentPort.postMessage({pages:doc.getPageCount()});}catch{parentPort.postMessage({error:true});}})();`, {
      eval: true, workerData: { modulePath: require.resolve("pdf-lib"), bytes },
      resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
    });
    let settled = false;
    const finish = (error, pages) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      if (error) reject(error); else resolve(pages);
    };
    const timer = setTimeout(() => finish(new SupplierAiExtractionError("PDF_LIMIT", "PDF validation exceeded its resource limit; split or recreate the PDF.")), LIMITS.pdfWorkerMs);
    worker.once("message", (message) => {
      if (message.error || !Number.isInteger(message.pages) || message.pages < 1) finish(new SupplierAiExtractionError("INVALID_PDF", "The PDF is corrupt, encrypted or unsupported."));
      else if (message.pages > LIMITS.pdfPages) finish(new SupplierAiExtractionError("PAGE_LIMIT", "The PDF exceeds 50 pages; split it into smaller imports."));
      else finish(null, message.pages);
    });
    worker.once("error", () => finish(new SupplierAiExtractionError("PDF_LIMIT", "PDF validation failed or exceeded its resource limit.")));
    worker.once("exit", (code) => { if (!settled) finish(new SupplierAiExtractionError("INVALID_PDF", `PDF validation did not complete${code ? " within resource bounds" : ""}.`)); });
  });
}

async function splitPdfBytes(bytes, pagesPerChunk) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
      (async()=>{try{const {PDFDocument}=require(workerData.modulePath);
      const doc=await PDFDocument.load(workerData.bytes,{ignoreEncryption:false,updateMetadata:false,throwOnInvalidObject:true});
      if(doc.getPageCount()<1||doc.getPageCount()>50)throw Error('pages');
      const chunks=[];let total=0;
      for(let start=0;start<doc.getPageCount();start+=workerData.pagesPerChunk){
        const part=await PDFDocument.create();const indexes=Array.from({length:Math.min(workerData.pagesPerChunk,doc.getPageCount()-start)},(_,i)=>start+i);
        for(const page of await part.copyPages(doc,indexes))part.addPage(page);
        const output=await part.save({useObjectStreams:true});total+=output.length;
        if(total>32*1024*1024||output.length>10*1024*1024)throw Error('size');
        chunks.push({bytes:output,startPage:start+1,pageCount:indexes.length});}
      parentPort.postMessage({chunks});}catch{parentPort.postMessage({error:true});}})();`, {
      eval: true, workerData: { modulePath: require.resolve("pdf-lib"), bytes, pagesPerChunk },
      resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
    });
    let settled = false;
    const finish = (error, chunks) => {
      if (settled) return;
      settled = true; clearTimeout(timer); worker.terminate().catch(() => {});
      if (error) reject(error); else resolve(chunks);
    };
    const timer = setTimeout(() => finish(new SupplierAiExtractionError("PDF_LIMIT", "PDF splitting exceeded its resource limit; split or recreate the PDF.")), LIMITS.pdfWorkerMs);
    worker.once("message", (message) => message.error ? finish(new SupplierAiExtractionError("PDF_LIMIT", "The PDF cannot be split within supported resource limits.")) : finish(null, message.chunks));
    worker.once("error", () => finish(new SupplierAiExtractionError("PDF_LIMIT", "PDF splitting failed or exceeded resource limits.")));
    worker.once("exit", () => { if (!settled) finish(new SupplierAiExtractionError("INVALID_PDF", "PDF splitting did not complete.")); });
  });
}

function validatePdfInflation(bytes) {
  // Object-stream bombs can allocate typed arrays outside the worker heap.
  // Pre-inflate direct Flate streams with an explicit output cap first. Reject
  // indirect/multi-stage Flate filters that cannot be bounded by this preflight.
  const raw = bytes.toString("latin1");
  let cursor = 0;
  let total = 0;
  let streams = 0;
  while (cursor < raw.length) {
    const match = /\bstream(?:\r\n|\n|\r)/g;
    match.lastIndex = cursor;
    const start = match.exec(raw);
    if (!start) break;
    const dataStart = start.index + start[0].length;
    const end = raw.indexOf("endstream", dataStart);
    if (end < 0 || ++streams > 10000) fail("INVALID_PDF", "The PDF has incomplete or excessive streams.");
    // Include outer dictionaries and nested DecodeParms, rather than choosing
    // only the last << (which could hide a filter in the outer dictionary).
    const dictionary = raw.slice(cursor, start.index).replace(/#([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    if (/\/Filter\s+\d+\s+\d+\s+R\b/.test(dictionary)) fail("UNSUPPORTED_PDF", "PDF streams with indirect filters are not supported; recreate or split the PDF.");
    if (/\/(?:LZWDecode|RunLengthDecode|LZW|RL)\b/.test(dictionary)) fail("UNSUPPORTED_PDF", "PDF LZW and run-length stream compression are not supported; recreate the PDF with standard compression.");
    if (/\/(?:FlateDecode|Fl)\b/.test(dictionary)) {
      if (/\/Filter\s*\[/.test(dictionary) && !/\/Filter\s*\[\s*\/(?:FlateDecode|Fl)\s*\]/.test(dictionary)) fail("UNSUPPORTED_PDF", "PDF multi-stage compressed filters are not supported; recreate the PDF.");
      let expanded;
      // A binary checksum may itself end in CR immediately before the PDF's
      // LF separator. Do not trim those indistinguishable bytes: zlib validates
      // the complete stream/checksum and ignores its trailing PDF separator.
      try { expanded = zlib.inflateSync(bytes.subarray(dataStart, end), { maxOutputLength: LIMITS.zipEntryBytes }); }
      catch { fail("PDF_LIMIT", "A PDF stream is corrupt or exceeds the 8 MiB decompression limit."); }
      total += expanded.length;
      if (total > LIMITS.zipExpandedBytes) fail("PDF_LIMIT", "The PDF exceeds 32 MiB of decompressed streams.");
    }
    cursor = end + 9;
  }
}

async function splitSupplierAiSource(source, { maxUnits = 100, maxPdfPages = 5, maxCharacters = 65536, maxChunks = 32 } = {}) {
  if (!source || !Array.isArray(source.units) || !source.units.length || !Number.isInteger(maxUnits) || maxUnits < 1 || maxUnits > 100
    || !Number.isInteger(maxPdfPages) || maxPdfPages < 1 || maxPdfPages > 5 || !Number.isInteger(maxCharacters) || maxCharacters < LIMITS.unitCharacters || maxCharacters > 65536
    || !Number.isInteger(maxChunks) || maxChunks < 1 || maxChunks > 32) fail("INVALID_CHUNK_POLICY", "The extraction chunk policy is invalid.");
  if (source.pdf) {
    const parts = await splitPdfBytes(source.pdf.bytes, maxPdfPages);
    if (parts.length > maxChunks) fail("CHUNK_LIMIT", "The source exceeds the maximum number of processing chunks; split it.");
    return parts.map((part, index) => ({
      chunkId: `chunk-${index + 1}`, format: source.format, warnings: source.warnings,
      units: source.units.slice(part.startPage - 1, part.startPage - 1 + part.pageCount).map((unit, pageIndex) => ({ ...unit,
        originalPage: part.startPage + pageIndex, chunkPage: pageIndex + 1 })),
      pdf: { bytes: Buffer.from(part.bytes), pageCount: part.pageCount, originalStartPage: part.startPage },
    }));
  }
  const chunks = [];
  const headers = source.format === "csv" ? source.units.slice(0, 1)
    : source.format === "xlsx" ? source.units.filter((unit) => unit.anchor.endsWith(" (possible header)")) : [];
  let current = [];
  let characters = 0;
  const publish = () => {
    if (!current.length) return;
    const relevantHeaders = headers.filter((header) => source.format !== "xlsx"
      || current.some((unit) => unit.sourceId.startsWith(header.sourceId.slice(0, header.sourceId.lastIndexOf("-row-") + 5))));
    const contextUnits = relevantHeaders.filter((header) => !current.some((unit) => unit.sourceId === header.sourceId));
    if (contextUnits.reduce((sum, unit) => sum + unit.text.length, characters) > maxCharacters) fail("CHUNK_LIMIT", "Worksheet headers and rows exceed the chunk context limit; split the source.");
    chunks.push({ chunkId: `chunk-${chunks.length + 1}`, format: source.format, units: current, contextUnits, warnings: source.warnings });
    current = []; characters = 0;
    if (chunks.length > maxChunks) fail("CHUNK_LIMIT", "The source exceeds 32 processing chunks; split it into smaller imports.");
  };
  for (const unit of source.units) {
    if (current.length && (current.length >= maxUnits || characters + unit.text.length > maxCharacters)) publish();
    current.push(unit); characters += unit.text.length;
  }
  publish();
  return chunks;
}

async function extractSupplierAiSource({ bytes, fileName, mimeType }) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1) fail("EMPTY_SOURCE", "Upload a nonempty file.");
  if (bytes.length > LIMITS.sourceBytes) fail("FILE_LIMIT", "The file exceeds the 10 MiB limit.");
  if (typeof fileName !== "string" || fileName.length > 256 || /[\/\\\u0000-\u001f]/.test(fileName)) fail("INVALID_FILE_NAME", "The file name is invalid.");
  const format = fileName.split(".").pop().toLowerCase();
  if (!TYPES[format]) fail("UNSUPPORTED_FILE", "Use CSV, XLSX, PDF, DOCX, EML or TXT files.");
  const mime = String(mimeType || "").split(";")[0].trim().toLowerCase();
  if (![...TYPES[format], "application/octet-stream", ""].includes(mime)) fail("TYPE_MISMATCH", "The file extension does not match the declared content type.");
  const result = collector();
  const output = { format, sourceSha256: crypto.createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length,
    units: result.units, warnings: result.warnings };
  if (["xlsx", "docx"].includes(format)) {
    if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) fail("TYPE_MISMATCH", "The file is not an Office ZIP document.");
    const members = boundedZip(bytes);
    if (format === "xlsx") await extractXlsx(bytes, members, result); else extractDocx(members, result);
  } else if (format === "pdf") {
    if (!bytes.subarray(0, 8).toString("ascii").match(/^%PDF-1\.[0-9]|^%PDF-2\.0/) || !bytes.subarray(Math.max(0, bytes.length - 4096)).includes(Buffer.from("%%EOF"))) fail("TYPE_MISMATCH", "The file is not a complete PDF document.");
    validatePdfInflation(bytes);
    const pageCount = await pdfPageCount(bytes);
    for (let page = 1; page <= pageCount; page += 1) {
      result.add(`pdf-page-${page}`, `PDF page ${page}`, `Page ${page} of ${pageCount}: consult the attached complete PDF, including page images and text.`);
      Object.assign(result.units[result.units.length - 1], { kind: "pdf-page", method: "vision", originalPage: page });
    }
    result.warn("PDF_VISION_REQUIRED", "The complete PDF is supplied for visual interpretation. Page references are traceable, but quoted PDF text is model interpretation and must be reviewed.");
    output.pdf = { pageCount, bytes };
  } else {
    if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) || bytes.subarray(0, 5).toString("ascii") === "%PDF-"
      || bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) fail("TYPE_MISMATCH", "A binary document was supplied as a text file.");
    if (format === "csv") extractCsv(bytes, result);
    else if (format === "eml") extractEml(bytes, result);
    else {
      inputText(bytes).split(/\r\n|\n|\r/).forEach((line, index) => result.add(`text-line-${index + 1}`, `Text line ${index + 1}`, line));
      if (!result.units.length) fail("EMPTY_SOURCE", "The source contains no supported text.");
    }
  }
  return output;
}

module.exports = { extractSupplierAiSource, splitSupplierAiSource, SupplierAiExtractionError, SUPPLIER_AI_EXTRACTION_LIMITS: LIMITS,
  // Internal worker entry; HTTP/callable code must always use the validated public extractor.
  __parseWorkbookForWorker: parseWorkbookForWorker };
