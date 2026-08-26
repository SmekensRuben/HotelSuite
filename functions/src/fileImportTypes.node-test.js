const test = require("node:test");
const assert = require("node:assert/strict");

process.env.FIREBASE_CONFIG = JSON.stringify({
  projectId: "hotel-suite-test",
  storageBucket: "hotel-suite-test.appspot.com",
});

const { parseXmlDocuments } = require("./fileImportTypes");

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
