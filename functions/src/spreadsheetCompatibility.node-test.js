const test = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");

test("patched ExcelJS uuid dependency writes extended formatting and reloads import values", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Fixture");
  sheet.addRows([["ID", "Net contribution"], ["0001", 150.5], ["0002", 200]]);
  sheet.addConditionalFormatting({ ref: "B2:B3", rules: [{ type: "iconSet", iconSet: "3Stars", cfvo: [{ type: "percent", value: 0 }, { type: "percent", value: 33 }, { type: "percent", value: 67 }] }] });
  const bytes = await workbook.xlsx.writeBuffer();
  assert.match(sheet.conditionalFormattings[0].rules[0].x14Id, /^\{[0-9A-F-]{36}\}$/);
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(bytes);
  assert.equal(restored.getWorksheet("Fixture").getCell("A2").value, "0001");
  assert.equal(restored.getWorksheet("Fixture").getCell("B2").value, 150.5);
});
