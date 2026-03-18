const { parse } = require("csv-parse/sync");
const { XMLParser } = require("fast-xml-parser");
const { onObjectFinalized, logger, admin } = require("./config");

function normalizeDelimiter(value) {
  const raw = String(value || ",");
  if (raw === "\\t" || raw.toLowerCase() === "tab") return "\t";
  return raw || ",";
}

function normalizeHeader(value, index) {
  const cleaned = String(value || "").trim();
  return cleaned || `column${index + 1}`;
}

function normalizeLookupKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeTargetType(value) {
  const normalized = String(value || "string").trim().toLowerCase();
  return ["string", "number", "array", "date"].includes(normalized) ? normalized : "string";
}

function normalizeSeparator(value) {
  const raw = String(value || ",");
  if (raw === "\\t" || raw === "\t" || raw.toLowerCase() === "tab") return "\t";
  if (raw === ";" || raw.toLowerCase() === "semicolon") return ";";
  if (raw === "|" || raw.toLowerCase() === "pipe") return "|";
  return ",";
}

function normalizeColumnMappings(fileImportType) {
  return Array.isArray(fileImportType?.columnMappings)
    ? fileImportType.columnMappings
        .map((mapping) => ({
          sourceField: String(mapping?.sourceField || mapping?.csvHeader || "").trim(),
          sourceFieldKey: normalizeLookupKey(mapping?.sourceField || mapping?.csvHeader || ""),
          databaseField: String(mapping?.databaseField || "").trim(),
          targetType: normalizeTargetType(mapping?.targetType),
          seperator: normalizeSeparator(mapping?.seperator),
          importFormat: String(mapping?.importFormat || "").trim(),
          targetFormat: String(mapping?.targetFormat || "").trim(),
        }))
        .filter((mapping) => mapping.sourceFieldKey && mapping.databaseField)
    : [];
}

function parsePhysicalLine(line, delimiter) {
  const parsed = parse(line, {
    bom: false,
    columns: false,
    delimiter,
    escape: '"',
    quote: '"',
    record_delimiter: ["\r\n", "\n", "\r"],
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: false,
    trim: false,
  });

  return Array.isArray(parsed) && parsed[0] ? parsed[0] : [];
}

function resolveExpectedColumnCount(configuredValue, headerLength) {
  const parsedConfiguredValue = Number(configuredValue);
  if (Number.isFinite(parsedConfiguredValue) && parsedConfiguredValue > 0) {
    return parsedConfiguredValue;
  }
  return headerLength || 0;
}

function buildLogicalRecords(content, delimiter, hasHeaderRow, configuredExpectedColumnCount = null) {
  const normalizedContent = String(content || "").replace(/^\uFEFF/, "");
  const physicalLines = normalizedContent.split(/\r\n|\n|\r/);
  const nonEmptyLines = physicalLines.filter((line) => line !== "");
  if (nonEmptyLines.length === 0) return { headerRow: [], dataRows: [] };

  const headerRow = parsePhysicalLine(nonEmptyLines[0], delimiter);
  const expectedColumnCount = resolveExpectedColumnCount(configuredExpectedColumnCount, headerRow.length);
  const startIndex = hasHeaderRow ? 1 : 0;
  const dataRows = [];
  let buffer = "";

  for (let index = startIndex; index < nonEmptyLines.length; index += 1) {
    buffer = buffer ? `${buffer}\n${nonEmptyLines[index]}` : nonEmptyLines[index];
    const parsedCandidate = parsePhysicalLine(buffer, delimiter);

    if (expectedColumnCount > 0 && parsedCandidate.length < expectedColumnCount && index < nonEmptyLines.length - 1) {
      continue;
    }

    if (expectedColumnCount > 0 && parsedCandidate.length > expectedColumnCount) {
      const normalizedCandidate = [...parsedCandidate.slice(0, expectedColumnCount - 1)];
      normalizedCandidate.push(parsedCandidate.slice(expectedColumnCount - 1).join(" "));
      dataRows.push(normalizedCandidate);
    } else {
      dataRows.push(parsedCandidate);
    }
    buffer = "";
  }

  if (buffer) {
    dataRows.push(parsePhysicalLine(buffer, delimiter));
  }

  return { headerRow, dataRows };
}

function parseWholeFileRecords(content, delimiter, hasHeaderRow) {
  const parsedRows = parse(String(content || ""), {
    bom: true,
    columns: false,
    delimiter,
    escape: '"',
    quote: '"',
    record_delimiter: ["\r\n", "\n", "\r"],
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    trim: false,
  });

  if (!Array.isArray(parsedRows) || parsedRows.length === 0) {
    return { headerRow: [], dataRows: [] };
  }

  const headerRow = parsedRows[0];
  const dataRows = hasHeaderRow ? parsedRows.slice(1) : parsedRows;
  return { headerRow, dataRows };
}

function scoreParsedRows(rows, expectedColumnCount) {
  if (!Array.isArray(rows) || rows.length === 0 || !expectedColumnCount) return 0;

  let exactMatches = 0;
  let usableRows = 0;

  rows.forEach((row) => {
    if (!Array.isArray(row)) return;
    if (row.length === expectedColumnCount) exactMatches += 1;
    if (row.length > 0) usableRows += 1;
  });

  return (exactMatches * 1000) + usableRows;
}

function mapDocumentsFromFlatRecords(records, normalizedMappings) {
  return records
    .map((record, index) => {
      const mappedDocument = {};
      normalizedMappings.forEach((mapping) => {
        mappedDocument[mapping.databaseField] = transformMappedValue(
          record?.[mapping.sourceFieldKey],
          mapping
        );
      });

      const hasMappedValue = Object.values(mappedDocument).some((value) => {
        if (Array.isArray(value)) return value.length > 0;
        return value !== "";
      });
      if (!hasMappedValue) return null;

      return {
        rowIndex: index,
        mappedDocument,
      };
    })
    .filter(Boolean);
}

function parseCsvDocuments(content, fileImportType) {
  const delimiter = normalizeDelimiter(fileImportType?.delimiter);
  const normalizedMappings = normalizeColumnMappings(fileImportType);
  if (normalizedMappings.length === 0) return [];

  const hasHeaderRow = fileImportType?.hasHeaderRow !== false;
  const configuredExpectedColumnCount = Number(fileImportType?.expectedColumnCount);
  const directRecords = parseWholeFileRecords(content, delimiter, hasHeaderRow);
  const bufferedRecords = buildLogicalRecords(content, delimiter, hasHeaderRow, configuredExpectedColumnCount);
  const directHeaderLength = Array.isArray(directRecords.headerRow) ? directRecords.headerRow.length : 0;
  const bufferedHeaderLength = Array.isArray(bufferedRecords.headerRow) ? bufferedRecords.headerRow.length : 0;
  const expectedColumnCount = resolveExpectedColumnCount(
    configuredExpectedColumnCount,
    directHeaderLength || bufferedHeaderLength
  );

  const recordParsingMode = String(fileImportType?.recordParsingMode || "auto").trim().toLowerCase();
  const selectedRecords = recordParsingMode === "direct"
    ? directRecords
    : recordParsingMode === "buffered"
      ? bufferedRecords
      : scoreParsedRows(directRecords.dataRows, expectedColumnCount) >=
          scoreParsedRows(bufferedRecords.dataRows, expectedColumnCount)
        ? directRecords
        : bufferedRecords;

  const { headerRow: rawHeaderRow, dataRows } = selectedRecords;
  if (!Array.isArray(rawHeaderRow) || rawHeaderRow.length === 0) return [];

  const headerRow = hasHeaderRow
    ? rawHeaderRow.map((value, index) => normalizeHeader(value, index))
    : rawHeaderRow.map((_, index) => `column${index + 1}`);

  const flatRecords = dataRows.map((values) => {
    const csvRow = {};
    headerRow.forEach((header, valueIndex) => {
      csvRow[normalizeLookupKey(header)] = String(values?.[valueIndex] ?? "").trim();
    });
    return csvRow;
  });

  return mapDocumentsFromFlatRecords(flatRecords, normalizedMappings);
}

function collectValuesByNodeName(value, normalizedNodeName, results = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectValuesByNodeName(item, normalizedNodeName, results));
    return results;
  }

  if (!value || typeof value !== "object") {
    return results;
  }

  Object.entries(value).forEach(([key, child]) => {
    if (normalizeLookupKey(key) === normalizedNodeName) {
      if (Array.isArray(child)) {
        child.forEach((item) => results.push(item));
      } else {
        results.push(child);
      }
    }

    collectValuesByNodeName(child, normalizedNodeName, results);
  });

  return results;
}

function flattenXmlRecord(value, prefix = "", target = {}) {
  if (Array.isArray(value)) {
    target[normalizeLookupKey(prefix)] = value.map((item) => String(item ?? "").trim()).join(", ");
    return target;
  }

  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, child]) => {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      flattenXmlRecord(child, nextPrefix, target);
    });
    return target;
  }

  if (prefix) {
    target[normalizeLookupKey(prefix)] = String(value ?? "").trim();
  }
  return target;
}

function parseXmlDocuments(content, fileImportType) {
  const normalizedMappings = normalizeColumnMappings(fileImportType);
  if (normalizedMappings.length === 0) return [];

  const recordNodeName = String(fileImportType?.recordNodeName || "").trim();
  if (!recordNodeName) return [];

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: true,
    trimValues: true,
  });

  const parsedXml = parser.parse(String(content || ""));
  const recordNodes = collectValuesByNodeName(parsedXml, normalizeLookupKey(recordNodeName));
  if (recordNodes.length === 0) return [];

  const flatRecords = recordNodes
    .map((recordNode) => flattenXmlRecord(recordNode))
    .filter((recordNode) => Object.keys(recordNode).length > 0);

  return mapDocumentsFromFlatRecords(flatRecords, normalizedMappings);
}

function parseImportedDocuments(content, fileImportType) {
  const parserType = String(fileImportType?.parserType || "csv").trim().toLowerCase();
  if (parserType === "xml") {
    return parseXmlDocuments(content, fileImportType);
  }
  return parseCsvDocuments(content, fileImportType);
}

function parseDateFromFormat(value, format) {
  const raw = String(value || "").trim();
  const normalizedFormat = String(format || "").trim();
  if (!raw) return null;

  const tokenPattern = normalizedFormat
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/yyyy/g, "(\\d{4})")
    .replace(/yy/g, "(\\d{2})")
    .replace(/MM/g, "(\\d{1,2})")
    .replace(/dd/g, "(\\d{1,2})");
  const match = new RegExp(`^${tokenPattern}$`).exec(raw);
  if (!match) return null;

  const tokenMatches = normalizedFormat.match(/yyyy|yy|MM|dd/g) || [];
  const tokenValues = {};
  tokenMatches.forEach((token, index) => {
    tokenValues[token] = Number(match[index + 1]);
  });

  const year = tokenValues.yyyy ?? (tokenValues.yy !== undefined ? 2000 + tokenValues.yy : undefined);
  const month = tokenValues.MM;
  const day = tokenValues.dd;
  if (!year || !month || !day) return null;

  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

function formatParsedDate(parts, format) {
  if (!parts) return "";

  const tokens = {
    yyyy: String(parts.year).padStart(4, "0"),
    MM: String(parts.month).padStart(2, "0"),
    dd: String(parts.day).padStart(2, "0"),
  };

  return String(format || "yyyy-MM-dd").replace(/yyyy|MM|dd/g, (token) => tokens[token] || token);
}

function convertDateValue(value, importFormat, targetFormat) {
  const parsedFromFormat = parseDateFromFormat(value, importFormat);
  if (parsedFromFormat) {
    return formatParsedDate(parsedFromFormat, targetFormat || "yyyy-MM-dd");
  }

  const direct = new Date(String(value || "").trim());
  if (!Number.isNaN(direct.getTime())) {
    return formatParsedDate(
      {
        year: direct.getUTCFullYear(),
        month: direct.getUTCMonth() + 1,
        day: direct.getUTCDate(),
      },
      targetFormat || "yyyy-MM-dd"
    );
  }

  return String(value || "").trim();
}

function transformMappedValue(rawValue, mapping) {
  const trimmedValue = String(rawValue ?? "").trim();

  switch (mapping?.targetType) {
    case "number": {
      if (!trimmedValue) return "";
      const normalizedNumber = Number(trimmedValue.replace(/\s+/g, "").replace(",", "."));
      return Number.isFinite(normalizedNumber) ? normalizedNumber : trimmedValue;
    }
    case "array":
      if (!trimmedValue) return [];
      return trimmedValue
        .split(mapping?.seperator || ",")
        .map((item) => String(item).trim())
        .filter(Boolean);
    case "date":
      if (!trimmedValue) return "";
      return convertDateValue(trimmedValue, mapping?.importFormat, mapping?.targetFormat);
    case "string":
    default:
      return trimmedValue;
  }
}

function formatDateValue(value) {
  if (!value) return "";
  return convertDateValue(value, "yyyy-MM-dd", "yyyy-MM-dd");
}

function buildDocumentId(mappedRow, fileImportType, fallbackValue) {
  const configuredIdFormat = Array.isArray(fileImportType?.idFormat) ? fileImportType.idFormat : [];
  const configuredSegments = configuredIdFormat
    .map((databaseField) => mappedRow?.[databaseField])
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);

  if (configuredSegments.length > 0) {
    return configuredSegments.join("_");
  }

  return String(mappedRow?.documentId || "").trim() || fallbackValue;
}

function buildTemplateContext({ hotelUid, fileType, fileImportType, mappedRow, object, rowIndex }) {
  const dateValue = fileImportType?.targetDateSourceType === "databaseField"
    ? formatDateValue(mappedRow?.[fileImportType.targetDateSourceField])
    : new Date().toISOString().slice(0, 10);

  const sourceName = String(object?.name || "").split("/").pop() || "import-file";
  const sourceBaseName = sourceName.replace(/\.[^.]+$/, "") || "import-file";
  const fallbackDocumentId = `${sourceBaseName}-${rowIndex + 1}`;

  return {
    hotelUid,
    fileType,
    date: dateValue,
    documentId: buildDocumentId(mappedRow, fileImportType, fallbackDocumentId),
    sourceFileName: sourceName,
    ...mappedRow,
  };
}

function interpolateTemplate(template, context) {
  return String(template || "")
    .replace(/\{([^}]+)\}/g, (_, key) => {
      const value = context[key];
      return value === undefined || value === null ? "" : String(value).trim();
    })
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

function resolveFirestorePath(fileImportType, context) {
  const basePath = interpolateTemplate(fileImportType?.basePath || "", context);
  const targetPath = interpolateTemplate(fileImportType?.targetPath || "", context);
  return [basePath, targetPath]
    .filter(Boolean)
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

async function writeRowToFirestore({ db, fileImportType, resolvedPath, context, payload }) {
  if (!resolvedPath) {
    throw new Error("Resolved Firestore path is leeg");
  }

  const segments = resolvedPath.split("/").filter(Boolean);
  const writeMode = String(fileImportType?.writeMode || "overwrite").trim().toLowerCase();

  if (segments.length % 2 === 0) {
    const docRef = db.doc(resolvedPath);
    if (writeMode === "merge") {
      await docRef.set(payload, { merge: true });
    } else {
      await docRef.set(payload);
    }
    return docRef.path;
  }

  const collectionRef = db.collection(resolvedPath);
  const normalizedDocId = String(context.documentId || "").trim();
  const shouldUseExplicitDocId = normalizedDocId && (writeMode === "overwrite" || writeMode === "merge");
  const docRef = shouldUseExplicitDocId ? collectionRef.doc(normalizedDocId) : collectionRef.doc();

  if (writeMode === "merge") {
    await docRef.set(payload, { merge: true });
  } else {
    await docRef.set(payload);
  }

  return docRef.path;
}

const processImportedFileToFirestore = onObjectFinalized({ region: "us-west1" }, async (event) => {
  const object = event.data || {};
  const objectName = String(object.name || "").trim();
  if (!objectName.startsWith("imports/")) {
    return;
  }

  const metadata = object.metadata || {};
  const hotelUid = String(metadata.hotelUid || "").trim();
  const fileType = String(metadata.fileType || "").trim();

  if (!hotelUid || !fileType) {
    logger.warn("Import skipped: missing hotelUid/fileType metadata", {
      objectName,
      hotelUid,
      fileType,
    });
    return;
  }

  const db = admin.firestore();
  const importTypeSnapshot = await db
    .collection("fileImportTypesIndex")
    .where("hotelUid", "==", hotelUid)
    .where("fileType", "==", fileType)
    .limit(1)
    .get();

  if (importTypeSnapshot.empty) {
    logger.warn("Import skipped: no matching file import type", {
      objectName,
      hotelUid,
      fileType,
    });
    return;
  }

  const importTypeDoc = importTypeSnapshot.docs[0];
  const fileImportType = { id: importTypeDoc.id, ...(importTypeDoc.data() || {}) };

  if (fileImportType.enabled === false) {
    logger.info("Import skipped: matching file import type is disabled", {
      objectName,
      hotelUid,
      fileType,
      fileImportTypeId: fileImportType.id,
    });
    return;
  }

  const parserType = String(fileImportType.parserType || "csv").trim().toLowerCase() || "csv";
  if (!["csv", "xml"].includes(parserType)) {
    logger.warn("Import skipped: unsupported parserType", {
      objectName,
      hotelUid,
      fileType,
      fileImportTypeId: fileImportType.id,
      parserType,
    });
    return;
  }

  const bucket = admin.storage().bucket(object.bucket);
  const [buffer] = await bucket.file(objectName).download();
  const mappedDocuments = parseImportedDocuments(buffer.toString("utf8"), fileImportType);

  if (mappedDocuments.length === 0) {
    logger.warn("Import skipped: no mapped rows found", {
      objectName,
      hotelUid,
      fileType,
      fileImportTypeId: fileImportType.id,
      parserType,
    });
    return;
  }

  const writeResults = [];
  for (const documentRow of mappedDocuments) {
    const context = buildTemplateContext({
      hotelUid,
      fileType,
      fileImportType,
      mappedRow: documentRow.mappedDocument,
      object,
      rowIndex: documentRow.rowIndex,
    });

    const resolvedPath = resolveFirestorePath(fileImportType, context);
    const writtenPath = await writeRowToFirestore({
      db,
      fileImportType,
      resolvedPath,
      context,
      payload: documentRow.mappedDocument,
    });

    writeResults.push(writtenPath);
  }

  logger.info("Import processed to Firestore", {
    objectName,
    hotelUid,
    fileType,
    fileImportTypeId: fileImportType.id,
    parserType,
    writtenCount: writeResults.length,
    firstWrittenPath: writeResults[0] || null,
  });
});

module.exports = {
  processImportedFileToFirestore,
};
