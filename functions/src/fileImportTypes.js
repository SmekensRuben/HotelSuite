const { onObjectFinalized, logger, admin } = require("./config");

function normalizeDelimiter(value) {
  const raw = String(value || ",");
  if (raw === "\\t" || raw.toLowerCase() === "tab") return "\t";
  return raw || ",";
}

function parseCsvLine(line, delimiter) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values.map((value) => value.trim());
}

function parseDelimitedText(content, delimiter) {
  const lines = String(content || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line) => parseCsvLine(line, delimiter));
}

function normalizeHeader(value, index) {
  const cleaned = String(value || "").trim();
  return cleaned || `column${index + 1}`;
}

function mapRows(parsedRows, fileImportType) {
  const rows = Array.isArray(parsedRows) ? parsedRows : [];
  if (rows.length === 0) return [];

  const hasHeaderRow = fileImportType?.hasHeaderRow !== false;
  const headerRow = hasHeaderRow
    ? rows[0].map((value, index) => normalizeHeader(value, index))
    : rows[0].map((_, index) => `column${index + 1}`);
  const dataRows = hasHeaderRow ? rows.slice(1) : rows;

  const normalizedMappings = Array.isArray(fileImportType?.columnMappings)
    ? fileImportType.columnMappings
        .map((mapping) => ({
          csvHeader: String(mapping?.csvHeader || "").trim(),
          databaseField: String(mapping?.databaseField || "").trim(),
        }))
        .filter((mapping) => mapping.csvHeader && mapping.databaseField)
    : [];

  return dataRows.map((values, index) => {
    const rawRow = {};
    headerRow.forEach((header, valueIndex) => {
      rawRow[header] = String(values?.[valueIndex] || "").trim();
    });

    const mappedRow = {};
    normalizedMappings.forEach((mapping) => {
      mappedRow[mapping.databaseField] = String(rawRow[mapping.csvHeader] || "").trim();
    });

    return {
      rowIndex: index,
      rawRow,
      mappedRow,
    };
  });
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

const processImportedFileToFirestore = onObjectFinalized(async (event) => {
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

  const bucket = admin.storage().bucket(object.bucket);
  const [buffer] = await bucket.file(objectName).download();
  const parsedRows = parseDelimitedText(buffer.toString("utf8"), normalizeDelimiter(fileImportType.delimiter));
  const mappedRows = mapRows(parsedRows, fileImportType);

  if (mappedRows.length === 0) {
    logger.warn("Import skipped: no data rows found", {
      objectName,
      hotelUid,
      fileType,
      fileImportTypeId: fileImportType.id,
    });
    return;
  }

  const writeResults = [];
  for (const row of mappedRows) {
    const context = buildTemplateContext({
      hotelUid,
      fileType,
      fileImportType,
      mappedRow: row.mappedRow,
      object,
      rowIndex: row.rowIndex,
    });

    const resolvedPath = resolveFirestorePath(fileImportType, context);
    const payload = {
      ...row.mappedRow,
      _importMeta: {
        hotelUid,
        fileType,
        fileImportTypeId: fileImportType.id,
        sourceObjectName: objectName,
        sourceBucket: object.bucket || "",
        importedAt: admin.firestore.FieldValue.serverTimestamp(),
        rowIndex: row.rowIndex,
        rawRow: row.rawRow,
      },
    };

    const writtenPath = await writeRowToFirestore({
      db,
      fileImportType,
      resolvedPath,
      context,
      payload,
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
