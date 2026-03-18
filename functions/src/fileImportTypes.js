const { parse } = require("csv-parse/sync");
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

function normalizeColumnMappings(fileImportType) {
  return Array.isArray(fileImportType?.columnMappings)
    ? fileImportType.columnMappings
        .map((mapping) => ({
          csvHeader: String(mapping?.csvHeader || "").trim(),
          csvHeaderKey: normalizeLookupKey(mapping?.csvHeader || ""),
          databaseField: String(mapping?.databaseField || "").trim(),
        }))
        .filter((mapping) => mapping.csvHeaderKey && mapping.databaseField)
    : [];
}

function stitchFragmentedRows(rows, expectedColumnCount) {
  if (!Array.isArray(rows) || rows.length === 0 || !expectedColumnCount) return rows || [];

  const stitchedRows = [];
  let buffer = null;

  const flushBuffer = () => {
    if (buffer) {
      stitchedRows.push(buffer);
      buffer = null;
    }
  };

  rows.forEach((row) => {
    const normalizedRow = Array.isArray(row)
      ? row.map((value) => String(value ?? ""))
      : [String(row ?? "")];

    if (!buffer) {
      buffer = normalizedRow;
      return;
    }

    if (buffer.length >= expectedColumnCount) {
      flushBuffer();
      buffer = normalizedRow;
      return;
    }

    if (normalizedRow.length === 0) {
      return;
    }

    const mergedRow = [...buffer];
    const lastIndex = mergedRow.length - 1;
    mergedRow[lastIndex] = `${mergedRow[lastIndex]} ${normalizedRow[0]}`.trim();
    if (normalizedRow.length > 1) {
      mergedRow.push(...normalizedRow.slice(1));
    }
    buffer = mergedRow;

    if (buffer.length >= expectedColumnCount) {
      flushBuffer();
    }
  });

  flushBuffer();
  return stitchedRows;
}

function parseCsvDocuments(content, fileImportType) {
  const delimiter = normalizeDelimiter(fileImportType?.delimiter);
  const normalizedMappings = normalizeColumnMappings(fileImportType);
  if (normalizedMappings.length === 0) return [];

  const hasHeaderRow = fileImportType?.hasHeaderRow !== false;
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

  if (!Array.isArray(parsedRows) || parsedRows.length === 0) return [];

  const headerRow = hasHeaderRow
    ? parsedRows[0].map((value, index) => normalizeHeader(value, index))
    : parsedRows[0].map((_, index) => `column${index + 1}`);
  const rawDataRows = hasHeaderRow ? parsedRows.slice(1) : parsedRows;
  const dataRows = stitchFragmentedRows(rawDataRows, headerRow.length);

  return dataRows
    .map((values, index) => {
      const csvRow = {};
      headerRow.forEach((header, valueIndex) => {
        csvRow[normalizeLookupKey(header)] = String(values?.[valueIndex] ?? "").trim();
      });

      const mappedDocument = {};
      normalizedMappings.forEach((mapping) => {
        mappedDocument[mapping.databaseField] = String(csvRow[mapping.csvHeaderKey] ?? "").trim();
      });

      const hasMappedValue = Object.values(mappedDocument).some((value) => value !== "");
      if (!hasMappedValue) return null;

      return {
        rowIndex: index,
        mappedDocument,
      };
    })
    .filter(Boolean);
}

function formatDateValue(value) {
  if (!value) return "";

  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) {
    return direct.toISOString().slice(0, 10);
  }

  const raw = String(value).trim();
  const dateMatch = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (dateMatch) {
    const [, first, second, yearRaw] = dateMatch;
    const year = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw;
    const firstNumber = Number(first);
    const secondNumber = Number(second);
    const assumedMonthFirst = firstNumber <= 12;
    const month = assumedMonthFirst ? firstNumber : secondNumber;
    const day = assumedMonthFirst ? secondNumber : firstNumber;
    const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.getTime())) {
      return iso;
    }
  }

  return raw;
}

function buildTemplateContext({ hotelUid, fileType, fileImportType, mappedRow, object, rowIndex }) {
  const dateValue = fileImportType?.targetDateSourceType === "databaseField"
    ? formatDateValue(mappedRow?.[fileImportType.targetDateSourceField])
    : new Date().toISOString().slice(0, 10);

  const sourceName = String(object?.name || "").split("/").pop() || "import-file";
  const sourceBaseName = sourceName.replace(/\.[^.]+$/, "") || "import-file";

  return {
    hotelUid,
    fileType,
    date: dateValue,
    documentId: String(mappedRow?.documentId || "").trim() || `${sourceBaseName}-${rowIndex + 1}`,
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

  const parserType = String(fileImportType.parserType || "").trim().toLowerCase();
  if (parserType !== "csv") {
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
  const mappedDocuments = parseCsvDocuments(buffer.toString("utf8"), fileImportType);

  if (mappedDocuments.length === 0) {
    logger.warn("Import skipped: no mapped CSV rows found", {
      objectName,
      hotelUid,
      fileType,
      fileImportTypeId: fileImportType.id,
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
    writtenCount: writeResults.length,
    firstWrittenPath: writeResults[0] || null,
  });
});

module.exports = {
  processImportedFileToFirestore,
};
