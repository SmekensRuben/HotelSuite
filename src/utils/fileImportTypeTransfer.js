const TRANSFER_FIELDS = [
  "fileType",
  "parserType",
  "delimiter",
  "recordNodeName",
  "hasHeaderRow",
  "targetCollection",
  "basePath",
  "targetPath",
  "idFormat",
  "targetDateSourceType",
  "targetDateSourceField",
  "targetDateOffsetDays",
  "recordParsingMode",
  "expectedColumnCount",
  "writeMode",
  "enabled",
  "columnMappings",
];

export function createFileImportTypeExport(fileImportType) {
  const configuration = Object.fromEntries(
    TRANSFER_FIELDS.map((field) => [field, fileImportType?.[field]])
  );

  return {
    format: "hotel-suite-file-import-type",
    version: 1,
    configuration,
  };
}

export function parseFileImportTypeImport(contents) {
  let parsed;

  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error("The selected file does not contain valid JSON.");
  }

  if (
    !parsed ||
    parsed.format !== "hotel-suite-file-import-type" ||
    parsed.version !== 1 ||
    !parsed.configuration ||
    typeof parsed.configuration !== "object" ||
    Array.isArray(parsed.configuration)
  ) {
    throw new Error("The selected file is not a valid File Import Type export.");
  }

  return Object.fromEntries(
    TRANSFER_FIELDS.map((field) => [field, parsed.configuration[field]])
  );
}

export function getFileImportTypeExportFilename(fileImportType) {
  const safeName = String(fileImportType?.fileType || "file-import-type")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return `${safeName || "file-import-type"}.json`;
}
