import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

describe("patched spreadsheet export/import compatibility", () => {
  it("round-trips all catalog rows, identifiers, localized text and decimal values", () => {
    const rows = Array.from({ length: 121 }, (_, index) => ({ id: `product-${index}`, name: `Café ${index}`, supplierCode: `00${index}`, price: index / 100 }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "Products");
    const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
    const restored = XLSX.read(bytes, { type: "array" });
    expect(XLSX.utils.sheet_to_json(restored.Sheets.Products)).toEqual(rows);
    expect(XLSX.version).toBe("0.20.3");
  });
});
