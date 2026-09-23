const test = require("node:test");
const assert = require("node:assert/strict");

process.env.FIREBASE_CONFIG = JSON.stringify({
  projectId: "hotel-suite-test",
  storageBucket: "hotel-suite-test.appspot.com",
});

const {
  aggregateMappedDocuments,
  mergeMappedDocuments,
  normalizeColumnMappings,
  parseCsvDocuments,
  parseXmlDocuments,
} = require("./fileImportTypes");

const fileImportType = {
  recordNodeName: "G_RESERVATION",
  columnMappings: [
    {
      sourceField: "EXTERNAL_REFERENCE",
      databaseField: "externalReference",
      targetType: "string",
    },
    {
      sourceField: "UPDATE_DATE",
      databaseField: "lastUpdateDate",
      targetType: "date",
      importFormat: "dd-MMM-yy",
      targetFormat: "yyyy-MM-dd",
    },
    {
      sourceField: "LIST_G_DEPT_ID",
      databaseField: "traces",
      targetType: "list",
      childMappings: [
        {
          sourceField: "GTV_TRACE_ON",
          databaseField: "traceDate",
          targetType: "date",
          importFormat: "dd.MM.yy",
          targetFormat: "yyyy-MM-dd",
        },
        {
          sourceField: "DEPT_ID",
          databaseField: "traceDepartment",
          targetType: "string",
        },
      ],
    },
  ],
};

test("keeps an Opera reservation when LIST_G_DEPT_ID contains only whitespace", () => {
  const documents = parseXmlDocuments(
    `<G_RESERVATION>
      <EXTERNAL_REFERENCE>71371920</EXTERNAL_REFERENCE>
      <UPDATE_DATE>25-AUG-26</UPDATE_DATE>
      <LIST_G_DEPT_ID> </LIST_G_DEPT_ID>
    </G_RESERVATION>`,
    fileImportType
  );

  assert.deepEqual(documents, [
    {
      rowIndex: 0,
      mappedDocument: {
        externalReference: "71371920",
        lastUpdateDate: "2026-08-25",
        traces: [],
      },
    },
  ]);
});

test("still maps populated XML list elements", () => {
  const documents = parseXmlDocuments(
    `<G_RESERVATION>
      <EXTERNAL_REFERENCE>71371920</EXTERNAL_REFERENCE>
      <UPDATE_DATE>25-AUG-26</UPDATE_DATE>
      <LIST_G_DEPT_ID>
        <G_DEPT_ID>
          <GTV_TRACE_ON>26.08.26</GTV_TRACE_ON>
          <DEPT_ID>FO</DEPT_ID>
        </G_DEPT_ID>
      </LIST_G_DEPT_ID>
    </G_RESERVATION>`,
    fileImportType
  );

  assert.deepEqual(documents[0].mappedDocument.traces, [
    {
      traceDate: "2026-08-26",
      traceDepartment: "FO",
    },
  ]);
});

const mapImportType = {
  parserType: "csv",
  delimiter: ",",
  hasHeaderRow: true,
  columnMappings: [
    { sourceField: "BUSINESS_DATE", databaseField: "businessDate", targetType: "string" },
    {
      databaseField: "roomsByType",
      targetType: "map",
      mapKeySourceField: "ROOM_TYPE",
      mapValueSourceField: "NO_OF_ROOMS1",
      mapValueType: "number",
      mapExcludedKeys: "Total",
    },
  ],
};

function aggregateByBusinessDate(csv) {
  const documents = parseCsvDocuments(csv, mapImportType);
  return aggregateMappedDocuments(
    documents,
    (row) => ({
      aggregationKey: row.mappedDocument.businessDate,
      payload: row.mappedDocument,
    }),
    normalizeColumnMappings(mapImportType)
  ).map((row) => row.payload);
}

test("combines map entries from rows for the same target document", () => {
  assert.deepEqual(
    aggregateByBusinessDate("BUSINESS_DATE,ROOM_TYPE,NO_OF_ROOMS1\n2026-09-23,QNK,2\n2026-09-23,DBDB,3"),
    [{ businessDate: "2026-09-23", roomsByType: { QNK: 2, DBDB: 3 } }]
  );
});

test("preserves zero and negative numeric map values", () => {
  assert.deepEqual(
    aggregateByBusinessDate("BUSINESS_DATE,ROOM_TYPE,NO_OF_ROOMS1\n2026-09-23,QNK,0\n2026-09-23,DBDB,-1"),
    [{ businessDate: "2026-09-23", roomsByType: { QNK: 0, DBDB: -1 } }]
  );
});

test("does not turn a missing map value into zero", () => {
  assert.deepEqual(
    aggregateByBusinessDate("BUSINESS_DATE,ROOM_TYPE,NO_OF_ROOMS1\n2026-09-23,QNK,\n2026-09-23,DBDB,3"),
    [{ businessDate: "2026-09-23", roomsByType: { DBDB: 3 } }]
  );
});

test("reports duplicate map keys instead of overwriting them", () => {
  assert.throws(
    () => aggregateByBusinessDate("BUSINESS_DATE,ROOM_TYPE,NO_OF_ROOMS1\n2026-09-23,QNK,2\n2026-09-23,QNK,3"),
    /Duplicate map key "QNK".*roomsByType/
  );
});

test("excludes Total from the map so it can be mapped separately", () => {
  assert.deepEqual(
    aggregateByBusinessDate("BUSINESS_DATE,ROOM_TYPE,NO_OF_ROOMS1\n2026-09-23,QNK,2\n2026-09-23,Total,5"),
    [{ businessDate: "2026-09-23", roomsByType: { QNK: 2 } }]
  );
});

test("keeps existing scalar, array, date and list merge behavior", () => {
  const mappings = normalizeColumnMappings({
    columnMappings: [
      { sourceField: "name", databaseField: "name", targetType: "string" },
      { sourceField: "count", databaseField: "count", targetType: "number" },
      { sourceField: "tags", databaseField: "tags", targetType: "array" },
      { sourceField: "date", databaseField: "date", targetType: "date", importFormat: "yyyy-MM-dd", targetFormat: "yyyy-MM-dd" },
      { databaseField: "items", targetType: "list", childMappings: [] },
    ],
  });
  assert.deepEqual(
    mergeMappedDocuments(
      { name: "old", count: 1, tags: ["old"], date: "2026-01-01", items: [{ id: "a" }] },
      { name: "new", count: 0, tags: ["new"], date: "2026-09-23", items: [{ id: "b" }] },
      mappings
    ),
    { name: "new", count: 0, tags: ["new"], date: "2026-09-23", items: [{ id: "a" }, { id: "b" }] }
  );
});
