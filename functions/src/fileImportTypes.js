const { parse } = require("csv-parse/sync");
const { parse: parseStream } = require("csv-parse");
const { XMLParser } = require("fast-xml-parser");
const sax = require("sax");
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
  return ["string", "number", "array", "date", "list"].includes(normalized) ? normalized : "string";
}

function normalizeSeparator(value) {
  const raw = String(value || ",");
  if (raw === "\\t" || raw === "\t" || raw.toLowerCase() === "tab") return "\t";
  if (raw === ";" || raw.toLowerCase() === "semicolon") return ";";
  if (raw === "|" || raw.toLowerCase() === "pipe") return "|";
  return ",";
}

function normalizeColumnMappings(fileImportType) {
  const normalizeMapping = (mapping) => ({
    sourceField: String(mapping?.sourceField || mapping?.csvHeader || "").trim(),
    sourceFieldKey: normalizeLookupKey(mapping?.sourceField || mapping?.csvHeader || ""),
    databaseField: String(mapping?.databaseField || "").trim(),
    targetType: normalizeTargetType(mapping?.targetType),
    seperator: normalizeSeparator(mapping?.seperator),
    importFormat: String(mapping?.importFormat || "").trim(),
    targetFormat: String(mapping?.targetFormat || "").trim(),
    listItemKeyField: String(mapping?.listItemKeyField || "").trim(),
    childMappings: Array.isArray(mapping?.childMappings)
      ? mapping.childMappings.map((childMapping) => normalizeMapping(childMapping))
      : [],
  });

  return Array.isArray(fileImportType?.columnMappings)
    ? fileImportType.columnMappings
        .map((mapping) => normalizeMapping(mapping))
        .filter((mapping) => mapping.databaseField && (mapping.targetType === "list" || mapping.sourceFieldKey))
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

function hasMappedValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") {
    return Object.values(value).some((childValue) => hasMappedValue(childValue));
  }
  return value !== "";
}

function mapFlatObject(record, mappings) {
  const mappedDocument = {};
  let shouldSkip = false;

  mappings.forEach((mapping) => {
    if (shouldSkip) return;

    if (mapping.targetType === "list") {
      const childItemResult = mapFlatObject(record, mapping.childMappings || []);
      if (childItemResult.shouldSkip) {
        shouldSkip = true;
        return;
      }

      mappedDocument[mapping.databaseField] = hasMappedValue(childItemResult.mappedDocument)
        ? [childItemResult.mappedDocument]
        : [];
      return;
    }

    const rawValue = record?.[mapping.sourceFieldKey];
    if (!isMappedValueValid(rawValue, mapping)) {
      shouldSkip = true;
      return;
    }

    mappedDocument[mapping.databaseField] = transformMappedValue(rawValue, mapping);
  });

  return { mappedDocument, shouldSkip };
}

function mapDocumentsFromFlatRecords(records, normalizedMappings) {
  return records
    .map((record, index) => {
      const { mappedDocument, shouldSkip } = mapFlatObject(record, normalizedMappings);
      if (shouldSkip || !hasMappedValue(mappedDocument)) return null;

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

function getXmlNodeByPath(value, pathSegments) {
  if (!pathSegments.length) return value;

  const [currentSegment, ...rest] = pathSegments;
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const resolved = getXmlNodeByPath(item, pathSegments);
      return Array.isArray(resolved) ? resolved : [resolved];
    });
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const matchingEntry = Object.entries(value).find(
    ([key]) => normalizeLookupKey(key) === normalizeLookupKey(currentSegment)
  );

  if (!matchingEntry) return undefined;
  const [, child] = matchingEntry;
  return rest.length === 0 ? child : getXmlNodeByPath(child, rest);
}

function resolveXmlSourceValue(recordNode, mapping, flattenedRecord) {
  const pathSegments = String(mapping?.sourceField || "")
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (pathSegments.length > 0) {
    const directValue = getXmlNodeByPath(recordNode, pathSegments);
    if (directValue !== undefined) {
      return directValue;
    }

    const nestedNodeMatches = collectValuesByNodeName(recordNode, normalizeLookupKey(pathSegments[pathSegments.length - 1]));
    if (nestedNodeMatches.length > 0) {
      if (mapping?.targetType === "list") {
        return nestedNodeMatches;
      }

      const primitiveMatches = nestedNodeMatches
        .filter((value) => value === null || value === undefined || typeof value !== "object")
        .map((value) => String(value ?? "").trim());

      if (primitiveMatches.length > 0) {
        return primitiveMatches[0];
      }
    }
  }

  return flattenedRecord?.[mapping?.sourceFieldKey];
}

function mapXmlObject(recordNode, mappings) {
  const flattenedRecord = flattenXmlRecord(recordNode);
  const mappedDocument = {};
  let shouldSkip = false;

  mappings.forEach((mapping) => {
    if (shouldSkip) return;

    const resolvedValue = resolveXmlSourceValue(recordNode, mapping, flattenedRecord);

    if (mapping.targetType === "list") {
      const sourceItems = Array.isArray(resolvedValue)
        ? resolvedValue
        : resolvedValue === undefined || resolvedValue === null
          ? []
          : [resolvedValue];

      const childItems = [];
      for (const item of sourceItems) {
        const childItemResult = mapXmlObject(item, mapping.childMappings || []);
        if (childItemResult.shouldSkip) {
          shouldSkip = true;
          return;
        }
        if (hasMappedValue(childItemResult.mappedDocument)) {
          childItems.push(childItemResult.mappedDocument);
        }
      }

      mappedDocument[mapping.databaseField] = childItems;
      return;
    }

    if (!isMappedValueValid(resolvedValue, mapping)) {
      shouldSkip = true;
      return;
    }

    mappedDocument[mapping.databaseField] = transformMappedValue(resolvedValue, mapping);
  });

  return { mappedDocument, shouldSkip };
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

  return recordNodes
    .map((recordNode, index) => {
      const { mappedDocument, shouldSkip } = mapXmlObject(recordNode, normalizedMappings);
      if (shouldSkip || !hasMappedValue(mappedDocument)) return null;

      return {
        rowIndex: index,
        mappedDocument,
      };
    })
    .filter(Boolean);
}

function parseImportedDocuments(content, fileImportType) {
  const parserType = String(fileImportType?.parserType || "csv").trim().toLowerCase();
  if (parserType === "xml") {
    return parseXmlDocuments(content, fileImportType);
  }
  return parseCsvDocuments(content, fileImportType);
}

async function processCsvDocumentsStream(fileStream, fileImportType, onMappedDocument) {
  const delimiter = normalizeDelimiter(fileImportType?.delimiter);
  const normalizedMappings = normalizeColumnMappings(fileImportType);
  if (normalizedMappings.length === 0) return 0;

  const hasHeaderRow = fileImportType?.hasHeaderRow !== false;
  const parser = parseStream({
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

  const csvStream = fileStream.pipe(parser);
  let headerRow = null;
  let rowIndex = 0;

  for await (const values of csvStream) {
    if (!headerRow) {
      headerRow = hasHeaderRow
        ? values.map((value, index) => normalizeHeader(value, index))
        : values.map((_, index) => `column${index + 1}`);

      if (hasHeaderRow) {
        continue;
      }
    }

    const flatRecord = {};
    headerRow.forEach((header, valueIndex) => {
      flatRecord[normalizeLookupKey(header)] = String(values?.[valueIndex] ?? "").trim();
    });

    const { mappedDocument, shouldSkip } = mapFlatObject(flatRecord, normalizedMappings);
    if (!shouldSkip && hasMappedValue(mappedDocument)) {
      // eslint-disable-next-line no-await-in-loop
      await onMappedDocument({ rowIndex, mappedDocument }, normalizedMappings);
    }

    rowIndex += 1;
  }

  return rowIndex;
}

function addXmlChild(parentObject, key, value) {
  if (!parentObject || typeof parentObject !== "object") return;

  if (parentObject[key] === undefined) {
    parentObject[key] = value;
    return;
  }

  if (Array.isArray(parentObject[key])) {
    parentObject[key].push(value);
    return;
  }

  parentObject[key] = [parentObject[key], value];
}

async function processXmlDocumentsStream(fileStream, fileImportType, onMappedDocument) {
  const normalizedMappings = normalizeColumnMappings(fileImportType);
  if (normalizedMappings.length === 0) return 0;

  const recordNodeName = String(fileImportType?.recordNodeName || "").trim();
  if (!recordNodeName) return 0;

  const normalizedRecordNodeName = normalizeLookupKey(recordNodeName);
  const parser = sax.parser(true, {
    trim: false,
    normalize: false,
  });

  const stack = [];
  let rowIndex = 0;
  let processedCount = 0;
  let pendingWrite = Promise.resolve();

  parser.onopentag = (node) => {
    const objectValue = {};
    Object.entries(node.attributes || {}).forEach(([key, value]) => {
      objectValue[`@_${key}`] = value;
    });

    stack.push({
      name: node.name,
      value: objectValue,
      text: "",
    });
  };

  parser.ontext = (text) => {
    if (!stack.length) return;
    stack[stack.length - 1].text += text;
  };

  parser.oncdata = (text) => {
    if (!stack.length) return;
    stack[stack.length - 1].text += text;
  };

  parser.onclosetag = (tagName) => {
    const currentNode = stack.pop();
    if (!currentNode) return;

    const trimmedText = currentNode.text.trim();
    const hasObjectChildren = Object.keys(currentNode.value).length > 0;
    const nodeValue = hasObjectChildren
      ? currentNode.value
      : trimmedText;

    if (normalizeLookupKey(tagName) === normalizedRecordNodeName) {
      const currentRowIndex = rowIndex;
      rowIndex += 1;

      pendingWrite = pendingWrite.then(async () => {
        const { mappedDocument, shouldSkip } = mapXmlObject(nodeValue, normalizedMappings);
        if (!shouldSkip && hasMappedValue(mappedDocument)) {
          processedCount += 1;
          await onMappedDocument({ rowIndex: currentRowIndex, mappedDocument }, normalizedMappings);
        }
      });
      return;
    }

    if (stack.length > 0) {
      addXmlChild(stack[stack.length - 1].value, currentNode.name, nodeValue);
    }
  };

  for await (const chunk of fileStream) {
    parser.write(chunk.toString("utf8"));
  }

  parser.close();
  await pendingWrite;
  return processedCount;
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
    yy: String(parts.year % 100).padStart(2, "0"),
    MM: String(parts.month).padStart(2, "0"),
    dd: String(parts.day).padStart(2, "0"),
  };

  return String(format || "yyyy-MM-dd").replace(/yyyy|yy|MM|dd/g, (token) => tokens[token] || token);
}

function convertDateValue(value, importFormat, targetFormat) {
  const parsedFromFormat = parseDateFromFormat(value, importFormat);
  if (parsedFromFormat) {
    return {
      value: formatParsedDate(parsedFromFormat, targetFormat || "yyyy-MM-dd"),
      isValid: true,
    };
  }

  const direct = new Date(String(value || "").trim());
  if (!Number.isNaN(direct.getTime())) {
    return {
      value: formatParsedDate(
        {
          year: direct.getUTCFullYear(),
          month: direct.getUTCMonth() + 1,
          day: direct.getUTCDate(),
        },
        targetFormat || "yyyy-MM-dd"
      ),
      isValid: true,
    };
  }

  return {
    value: String(value || "").trim(),
    isValid: false,
  };
}

function isMappedValueValid(rawValue, mapping) {
  if (mapping?.targetType !== "date") return true;
  const trimmedValue = String(rawValue ?? "").trim();
  if (!trimmedValue) return false;
  return convertDateValue(trimmedValue, mapping?.importFormat, mapping?.targetFormat).isValid;
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
      return convertDateValue(trimmedValue, mapping?.importFormat, mapping?.targetFormat).value;
    case "string":
    default:
      return trimmedValue;
  }
}

function formatDateValue(value) {
  if (!value) return "";
  return convertDateValue(value, "yyyy-MM-dd", "yyyy-MM-dd").value;
}

function resolveCurrentDateWithOffset(offsetDays) {
  const normalizedOffset = Number.isInteger(Number(offsetDays)) ? Number(offsetDays) : 0;
  const currentDate = new Date();
  currentDate.setUTCHours(0, 0, 0, 0);
  currentDate.setUTCDate(currentDate.getUTCDate() + normalizedOffset);
  return currentDate.toISOString().slice(0, 10);
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
    : resolveCurrentDateWithOffset(fileImportType?.targetDateOffsetDays);

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

function resolveWriteTarget(fileImportType, resolvedPath, context) {
  const segments = String(resolvedPath || "").split("/").filter(Boolean);
  const writeMode = String(fileImportType?.writeMode || "overwrite").trim().toLowerCase();

  if (segments.length % 2 === 0) {
    return {
      docPath: resolvedPath,
      isExplicitDocument: true,
    };
  }

  const normalizedDocId = String(context?.documentId || "").trim();
  const shouldUseExplicitDocId = normalizedDocId && (writeMode === "overwrite" || writeMode === "merge");
  return {
    docPath: shouldUseExplicitDocId ? `${resolvedPath}/${normalizedDocId}`.replace(/\/+/g, "/") : "",
    isExplicitDocument: Boolean(shouldUseExplicitDocId),
  };
}

function getListItemKeyValue(listItem, keyField) {
  if (!keyField) return "";
  return String(listItem?.[keyField] ?? "").trim();
}

function mergeListItems(existingItems, incomingItems, keyField) {
  const mergedItems = Array.isArray(existingItems) ? [...existingItems] : [];
  if (!keyField) {
    return [...mergedItems, ...(Array.isArray(incomingItems) ? incomingItems : [])];
  }

  const existingKeys = new Set(
    mergedItems
      .map((listItem) => getListItemKeyValue(listItem, keyField))
      .filter(Boolean)
  );

  (Array.isArray(incomingItems) ? incomingItems : []).forEach((incomingItem) => {
    const incomingKey = getListItemKeyValue(incomingItem, keyField);
    if (incomingKey && existingKeys.has(incomingKey)) {
      return;
    }

    mergedItems.push(incomingItem);
    if (incomingKey) {
      existingKeys.add(incomingKey);
    }
  });

  return mergedItems;
}

function mergeMappedDocuments(existingDocument, incomingDocument, mappings) {
  const mergedDocument = {
    ...(existingDocument && typeof existingDocument === "object" ? existingDocument : {}),
  };

  mappings.forEach((mapping) => {
    const fieldName = mapping?.databaseField;
    if (!fieldName) return;

    if (mapping.targetType === "list") {
      const existingItems = Array.isArray(mergedDocument[fieldName]) ? mergedDocument[fieldName] : [];
      const incomingItems = Array.isArray(incomingDocument?.[fieldName]) ? incomingDocument[fieldName] : [];
      mergedDocument[fieldName] = mergeListItems(existingItems, incomingItems, mapping.listItemKeyField);
      return;
    }

    const incomingValue = incomingDocument?.[fieldName];
    if (incomingValue !== undefined && hasMappedValue(incomingValue)) {
      mergedDocument[fieldName] = incomingValue;
    }
  });

  return mergedDocument;
}

function aggregateMappedDocuments(mappedDocuments, buildRowDetails, mappings) {
  const aggregatedDocuments = new Map();

  mappedDocuments.forEach((documentRow, index) => {
    const rowDetails = buildRowDetails(documentRow, index);
    const aggregationKey = rowDetails.aggregationKey || `${rowDetails.resolvedPath}#${index}`;
    const existingRow = aggregatedDocuments.get(aggregationKey);

    if (!existingRow) {
      aggregatedDocuments.set(aggregationKey, rowDetails);
      return;
    }

    existingRow.payload = mergeMappedDocuments(existingRow.payload, rowDetails.payload, mappings);
  });

  return Array.from(aggregatedDocuments.values());
}

function touchDocumentCache(documentCache, cacheKey, value) {
  if (!documentCache) return;
  if (documentCache.has(cacheKey)) {
    documentCache.delete(cacheKey);
  }
  documentCache.set(cacheKey, value);
}


function getAncestorDocumentPaths(finalDocPath) {
  const segments = String(finalDocPath || "").split("/").filter(Boolean);
  const ancestorPaths = [];

  for (let index = 0; index < segments.length - 2; index += 2) {
    ancestorPaths.push(segments.slice(0, index + 2).join("/"));
  }

  return ancestorPaths;
}

async function ensureQueryableAncestorDocuments({ db, bulkWriter, finalDocPath, touchedAncestorPaths }) {
  const ancestorPaths = getAncestorDocumentPaths(finalDocPath);

  for (const ancestorPath of ancestorPaths) {
    if (touchedAncestorPaths?.has(ancestorPath)) {
      continue;
    }

    const docRef = db.doc(ancestorPath);
    const payload = {
      queryable: true,
    };

    if (bulkWriter) {
      bulkWriter.set(docRef, payload, { merge: true });
    } else {
      // eslint-disable-next-line no-await-in-loop
      await docRef.set(payload, { merge: true });
    }

    touchedAncestorPaths?.add(ancestorPath);
  }
}

async function commitFirestoreWrite({ db, bulkWriter, fileImportType, resolvedPath, context, payload, touchedAncestorPaths }) {
  if (!resolvedPath) {
    throw new Error("Resolved Firestore path is leeg");
  }

  const writeMode = String(fileImportType?.writeMode || "overwrite").trim().toLowerCase();
  const writeTarget = resolveWriteTarget(fileImportType, resolvedPath, context);

  if (writeTarget.isExplicitDocument) {
    await ensureQueryableAncestorDocuments({
      db,
      bulkWriter,
      finalDocPath: writeTarget.docPath,
      touchedAncestorPaths,
    });

    const docRef = db.doc(writeTarget.docPath);
    if (bulkWriter) {
      if (writeMode === "merge") {
        bulkWriter.set(docRef, payload, { merge: true });
      } else {
        bulkWriter.set(docRef, payload);
      }
      return docRef.path;
    }

    if (writeMode === "merge") {
      await docRef.set(payload, { merge: true });
    } else {
      await docRef.set(payload);
    }
    return docRef.path;
  }

  const docRef = db.collection(resolvedPath).doc();
  await ensureQueryableAncestorDocuments({
    db,
    bulkWriter,
    finalDocPath: docRef.path,
    touchedAncestorPaths,
  });
  if (bulkWriter) {
    bulkWriter.set(docRef, payload);
    return docRef.path;
  }

  await docRef.set(payload);
  return docRef.path;
}

async function flushOldestCachedDocument({ db, bulkWriter, fileImportType, documentCache, touchedAncestorPaths }) {
  if (!documentCache.size) return null;

  const oldestEntry = documentCache.entries().next().value;
  if (!oldestEntry) return null;

  const [cacheKey, cachedDocument] = oldestEntry;
  documentCache.delete(cacheKey);

  return commitFirestoreWrite({
    db,
    bulkWriter,
    fileImportType,
    resolvedPath: cachedDocument.resolvedPath,
    context: cachedDocument.context,
    payload: cachedDocument.payload,
    touchedAncestorPaths,
  });
}

async function enqueueMappedDocumentWrite({
  db,
  bulkWriter,
  fileImportType,
  resolvedPath,
  context,
  payload,
  mappings,
  documentCache,
  maxCacheEntries = 100,
  touchedAncestorPaths,
}) {
  const writeTarget = resolveWriteTarget(fileImportType, resolvedPath, context);

  if (!writeTarget.isExplicitDocument) {
    const writtenPath = await commitFirestoreWrite({
      db,
      bulkWriter,
      fileImportType,
      resolvedPath,
      context,
      payload,
      touchedAncestorPaths,
    });

    return { flushedPaths: [writtenPath] };
  }

  const cacheKey = writeTarget.docPath;
  const existingEntry = documentCache.get(cacheKey);

  if (existingEntry) {
    existingEntry.payload = mergeMappedDocuments(existingEntry.payload, payload, mappings);
    touchDocumentCache(documentCache, cacheKey, existingEntry);
    return { flushedPaths: [] };
  }

  const docSnapshot = await db.doc(cacheKey).get();
  const mergedPayload = docSnapshot.exists
    ? mergeMappedDocuments(docSnapshot.data() || {}, payload, mappings)
    : payload;

  touchDocumentCache(documentCache, cacheKey, {
    resolvedPath,
    context,
    payload: mergedPayload,
  });

  const flushedPaths = [];
  while (documentCache.size > maxCacheEntries) {
    // eslint-disable-next-line no-await-in-loop
    const flushedPath = await flushOldestCachedDocument({
      db,
      bulkWriter,
      fileImportType,
      documentCache,
      touchedAncestorPaths,
    });
    if (flushedPath) {
      flushedPaths.push(flushedPath);
    }
  }

  return { flushedPaths };
}

async function processWithConcurrency(items, concurrency, handler) {
  if (!Array.isArray(items) || items.length === 0) return;

  let currentIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);

  const workers = Array.from({ length: workerCount }, async () => {
    while (currentIndex < items.length) {
      const item = items[currentIndex];
      currentIndex += 1;
      // eslint-disable-next-line no-await-in-loop
      await handler(item);
    }
  });

  await Promise.all(workers);
}

async function processMappedDocumentStream({
  db,
  fileImportType,
  hotelUid,
  fileType,
  object,
  onEachMappedDocument,
}) {
  const normalizedMappings = normalizeColumnMappings(fileImportType);
  const bulkWriter = typeof db.bulkWriter === "function" ? db.bulkWriter() : null;
  const touchedAncestorPaths = new Set();
  const documentCache = new Map();
  const pendingDocuments = [];
  const batchSize = 500;
  const maxCacheEntries = 100;
  let writtenCount = 0;
  let firstWrittenPath = null;

  const registerWrittenPaths = (flushedPaths = []) => {
    flushedPaths.forEach((writtenPath) => {
      if (!writtenPath) return;
      writtenCount += 1;
      if (!firstWrittenPath) {
        firstWrittenPath = writtenPath;
      }
    });
  };

  const flushPendingDocuments = async () => {
    if (pendingDocuments.length === 0) return;

    const currentBatch = pendingDocuments.splice(0, pendingDocuments.length);
    const rowsToWrite = aggregateMappedDocuments(
      currentBatch,
      (documentRow) => {
        const context = buildTemplateContext({
          hotelUid,
          fileType,
          fileImportType,
          mappedRow: documentRow.mappedDocument,
          object,
          rowIndex: documentRow.rowIndex,
        });

        const resolvedPath = resolveFirestorePath(fileImportType, context);
        const writeTarget = resolveWriteTarget(fileImportType, resolvedPath, context);

        return {
          aggregationKey: writeTarget.isExplicitDocument ? writeTarget.docPath : `${resolvedPath}#${documentRow.rowIndex}`,
          context,
          resolvedPath,
          payload: documentRow.mappedDocument,
        };
      },
      normalizedMappings
    );

    for (const rowToWrite of rowsToWrite) {
      // eslint-disable-next-line no-await-in-loop
      const { flushedPaths } = await enqueueMappedDocumentWrite({
        db,
        bulkWriter,
        fileImportType,
        resolvedPath: rowToWrite.resolvedPath,
        context: rowToWrite.context,
        payload: rowToWrite.payload,
        mappings: normalizedMappings,
        documentCache,
        maxCacheEntries,
        touchedAncestorPaths,
      });

      registerWrittenPaths(flushedPaths);
    }
  };

  await onEachMappedDocument(async (documentRow) => {
    pendingDocuments.push(documentRow);
    if (pendingDocuments.length >= batchSize) {
      await flushPendingDocuments();
    }
  });

  await flushPendingDocuments();

  while (documentCache.size > 0) {
    // eslint-disable-next-line no-await-in-loop
    const flushedPath = await flushOldestCachedDocument({
      db,
      bulkWriter,
      fileImportType,
      documentCache,
      touchedAncestorPaths,
    });
    registerWrittenPaths(flushedPath ? [flushedPath] : []);
  }

  if (bulkWriter) {
    await bulkWriter.close();
  }

  return { writtenCount, firstWrittenPath };
}

const processImportedFileToFirestore = onObjectFinalized({ region: "us-west1", memory: "1GiB" }, async (event) => {
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
  const sourceFile = bucket.file(objectName);

  const writeSummary = await processMappedDocumentStream({
    db,
    fileImportType,
    hotelUid,
    fileType,
    object,
    onEachMappedDocument: async (onMappedDocument) => {
      if (parserType === "xml") {
        await processXmlDocumentsStream(sourceFile.createReadStream(), fileImportType, onMappedDocument);
        return;
      }

      await processCsvDocumentsStream(sourceFile.createReadStream(), fileImportType, onMappedDocument);
    },
  });

  if (writeSummary.writtenCount === 0) {
    logger.warn("Import skipped: no mapped rows found", {
      objectName,
      hotelUid,
      fileType,
      fileImportTypeId: fileImportType.id,
      parserType,
    });
    return;
  }

  logger.info("Import processed to Firestore", {
    objectName,
    hotelUid,
    fileType,
    fileImportTypeId: fileImportType.id,
    parserType,
    writtenCount: writeSummary.writtenCount,
    firstWrittenPath: writeSummary.firstWrittenPath,
  });
});

module.exports = {
  processImportedFileToFirestore,
};
