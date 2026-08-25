const test = require("node:test");
const assert = require("node:assert/strict");

process.env.FIREBASE_CONFIG = JSON.stringify({
  projectId: "hotel-suite-test",
  storageBucket: "hotel-suite-test.appspot.com",
});

const { parseXmlDocuments } = require("./fileImportTypes");

const fileImportType = {
  recordNodeName: "reservation",
  columnMappings: [
    {
      sourceField: "id",
      databaseField: "id",
      targetType: "string",
    },
    {
      sourceField: "items.item",
      databaseField: "items",
      targetType: "list",
      childMappings: [
        {
          sourceField: "date",
          databaseField: "date",
          targetType: "date",
          importFormat: "yyyy-MM-dd",
          targetFormat: "yyyy-MM-dd",
        },
      ],
    },
  ],
};

test("keeps an XML record when its mapped list element is empty", () => {
  const documents = parseXmlDocuments(
    "<reservations><reservation><id>123</id><items><item /></items></reservation></reservations>",
    fileImportType
  );

  assert.deepEqual(documents, [
    {
      rowIndex: 0,
      mappedDocument: {
        id: "123",
        items: [],
      },
    },
  ]);
});

test("still maps populated XML list elements", () => {
  const documents = parseXmlDocuments(
    "<reservations><reservation><id>123</id><items><item><date>2026-08-25</date></item></items></reservation></reservations>",
    fileImportType
  );

  assert.equal(documents[0].mappedDocument.items[0].date, "2026-08-25");
});
