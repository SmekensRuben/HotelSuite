import { describe, expect, it } from "vitest";
import {
  createFileImportTypeExport,
  getFileImportTypeExportFilename,
  parseFileImportTypeImport,
} from "./fileImportTypeTransfer";

describe("File Import Type transfer", () => {
  it("exports and imports configuration without document metadata", () => {
    const source = {
      id: "internal-id",
      fileType: "Daily arrivals",
      parserType: "csv",
      delimiter: ";",
      enabled: true,
      columnMappings: [{ sourceField: "Name", databaseField: "name", targetType: "string" }],
      createdBy: "user-id",
    };

    const exported = createFileImportTypeExport(source);
    const imported = parseFileImportTypeImport(JSON.stringify(exported));

    expect(exported).toMatchObject({ format: "hotel-suite-file-import-type", version: 1 });
    expect(imported).toMatchObject({ fileType: "Daily arrivals", delimiter: ";", enabled: true });
    expect(imported).not.toHaveProperty("id");
    expect(imported).not.toHaveProperty("createdBy");
  });

  it("rejects unrelated JSON files", () => {
    expect(() => parseFileImportTypeImport('{"fileType":"arrivals"}')).toThrow(
      "not a valid File Import Type export"
    );
  });

  it("creates a filesystem-safe filename", () => {
    expect(getFileImportTypeExportFilename({ fileType: "Daily Arrivals / PMS" })).toBe(
      "daily-arrivals-pms.json"
    );
  });
});
