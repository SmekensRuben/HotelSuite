import React, { useMemo } from "react";
import { Plus, Trash2 } from "lucide-react";

const defaultMapping = {
  sourceField: "",
  databaseField: "",
  targetType: "string",
  seperator: ",",
  importFormat: "",
  targetFormat: "",
};

const delimiterOptions = [
  { value: ",", label: "Comma (,)" },
  { value: ";", label: "Semicolon (;)" },
  { value: "\t", label: "Tab" },
  { value: "|", label: "Pipe (|)" },
];

const recordParsingModeOptions = [
  { value: "auto", label: "Auto" },
  { value: "direct", label: "Direct parse" },
  { value: "buffered", label: "Buffered recovery" },
];

const targetTypeOptions = [
  { value: "string", label: "String" },
  { value: "number", label: "Number" },
  { value: "array", label: "Array" },
  { value: "date", label: "Date" },
];

const separatorOptions = [
  { value: ",", label: "Komma (,)" },
  { value: "\t", label: "Tab" },
  { value: ";", label: "Semicolon (;)" },
  { value: "|", label: "Pipe (|)" },
];

const dateFormatOptions = [
  { value: "yyyy-MM-dd", label: "yyyy-MM-dd" },
  { value: "MM/dd/yyyy", label: "MM/dd/yyyy" },
  { value: "dd/MM/yyyy", label: "dd/MM/yyyy" },
  { value: "dd-MM-yyyy", label: "dd-MM-yyyy" },
  { value: "MM-dd-yyyy", label: "MM-dd-yyyy" },
  { value: "yyyy/MM/dd", label: "yyyy/MM/dd" },
  { value: "dd.MM.yyyy", label: "dd.MM.yyyy" },
  { value: "MM.dd.yyyy", label: "MM.dd.yyyy" },
];

export const initialFileImportTypeValues = {
  fileType: "csv",
  parserType: "csv",
  delimiter: ",",
  hasHeaderRow: true,
  targetCollection: "",
  basePath: "",
  targetPath: "",
  targetDateSourceType: "currentDate",
  targetDateSourceField: "",
  recordParsingMode: "auto",
  expectedColumnCount: "",
  recordNodeName: "",
  writeMode: "overwrite",
  enabled: true,
  columnMappings: [defaultMapping],
};

function Field({ label, htmlFor, children, hint }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-gray-700 mb-1">
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1 text-xs text-gray-500">{hint}</p> : null}
    </div>
  );
}

export default function FileImportTypeForm({
  formValues,
  onChange,
  onToggle,
  onMappingChange,
  onAddMapping,
  onRemoveMapping,
  onSubmit,
  onCancel,
  saving,
  submitLabel,
}) {
  const isXmlParser = formValues.parserType === "xml";

  const databaseFieldOptions = useMemo(
    () =>
      formValues.columnMappings
        .map((mapping) => ({
          sourceField: String(mapping?.sourceField || mapping?.csvHeader || "").trim(),
          databaseField: String(mapping?.databaseField || "").trim(),
        }))
        .filter((mapping) => mapping.sourceField && mapping.databaseField),
    [formValues.columnMappings]
  );

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="File Type" htmlFor="file-type">
          <input
            id="file-type"
            type="text"
            value={formValues.fileType}
            onChange={onChange("fileType")}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            placeholder="csv"
            required
          />
        </Field>

        <Field label="Parser Type" htmlFor="parser-type">
          <select
            id="parser-type"
            value={formValues.parserType}
            onChange={onChange("parserType")}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="csv">CSV</option>
            <option value="xml">XML</option>
          </select>
        </Field>

        {isXmlParser ? (
          <Field
            label="Record Node Name"
            htmlFor="record-node-name"
            hint="Required for XML imports. This is the repeating XML node that represents one record; source fields map to child nodes within it."
          >
            <input
              id="record-node-name"
              type="text"
              value={formValues.recordNodeName}
              onChange={onChange("recordNodeName")}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              placeholder="record"
              required={isXmlParser}
            />
          </Field>
        ) : (
          <Field
            label="Delimiter"
            htmlFor="delimiter"
            hint="Choose how columns are separated in the incoming file. Use Tab for tab-delimited TXT/CSV files."
          >
            <select
              id="delimiter"
              value={formValues.delimiter}
              onChange={onChange("delimiter")}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              {delimiterOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field
          label="Target Collection"
          htmlFor="target-collection"
          hint="Optional. Leave empty when the Firestore write path is fully defined through Base Path + Target Path."
        >
          <input
            id="target-collection"
            type="text"
            value={formValues.targetCollection}
            onChange={onChange("targetCollection")}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            placeholder="inventory"
          />
        </Field>

        <Field
          label="Base Path"
          htmlFor="base-path"
          hint='Example: hotels/{hotelUid}/reports/operaReports/'
        >
          <input
            id="base-path"
            type="text"
            value={formValues.basePath}
            onChange={onChange("basePath")}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            placeholder="hotels/{hotelUid}/reports/operaReports/"
          />
        </Field>

        <Field
          label="Target Path"
          htmlFor="target-path"
          hint='Example: {fileType}/{date}/{documentId}'
        >
          <input
            id="target-path"
            type="text"
            value={formValues.targetPath}
            onChange={onChange("targetPath")}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            placeholder="{fileType}/{date}/{documentId}"
          />
        </Field>

        <Field label="Date Source" htmlFor="target-date-source-type">
          <select
            id="target-date-source-type"
            value={formValues.targetDateSourceType}
            onChange={onChange("targetDateSourceType")}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="currentDate">Current Date</option>
            <option value="databaseField">Database Field</option>
          </select>
        </Field>

        <Field
          label="Date Database Field"
          htmlFor="target-date-source-field"
          hint={
            formValues.targetDateSourceType === "databaseField"
              ? `Choose a database field from the configured column mappings. The mapped ${isXmlParser ? "XML node value" : "source value"} will later be parsed as a date.`
              : "Only used when Date Source is set to Database Field."
          }
        >
          <select
            id="target-date-source-field"
            value={formValues.targetDateSourceField}
            onChange={onChange("targetDateSourceField")}
            disabled={formValues.targetDateSourceType !== "databaseField"}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:bg-gray-100"
          >
            <option value="">Select a database field</option>
            {databaseFieldOptions.map((mapping) => (
              <option key={`${mapping.databaseField}-${mapping.sourceField}`} value={mapping.databaseField}>
                {mapping.databaseField} ← {mapping.sourceField}
              </option>
            ))}
          </select>
        </Field>

        {!isXmlParser ? (
          <Field
            label="Record Parsing Mode"
            htmlFor="record-parsing-mode"
            hint="Use Auto by default. Switch to Direct or Buffered only if a specific import type consistently parses better with one strategy."
          >
            <select
              id="record-parsing-mode"
              value={formValues.recordParsingMode}
              onChange={onChange("recordParsingMode")}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              {recordParsingModeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        ) : null}

        {!isXmlParser ? (
          <Field
            label="Expected Column Count"
            htmlFor="expected-column-count"
            hint="Optional. Helps the parser decide when a row is incomplete or accidentally split over multiple physical lines."
          >
            <input
              id="expected-column-count"
              type="number"
              min="1"
              value={formValues.expectedColumnCount}
              onChange={onChange("expectedColumnCount")}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              placeholder="Leave empty to derive from header"
            />
          </Field>
        ) : null}

        <Field label="Write Mode" htmlFor="write-mode">
          <input
            id="write-mode"
            type="text"
            value={formValues.writeMode}
            onChange={onChange("writeMode")}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            placeholder="overwrite"
          />
        </Field>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {!isXmlParser ? (
          <label className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
            <input
              type="checkbox"
              checked={formValues.hasHeaderRow}
              onChange={onToggle("hasHeaderRow")}
              className="h-4 w-4 rounded border-gray-300 text-[#b41f1f]"
            />
            <span className="text-sm font-medium text-gray-700">Has Header Row</span>
          </label>
        ) : (
          <div />
        )}

        <label className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
          <input
            type="checkbox"
            checked={formValues.enabled}
            onChange={onToggle("enabled")}
            className="h-4 w-4 rounded border-gray-300 text-[#b41f1f]"
          />
          <span className="text-sm font-medium text-gray-700">Enabled</span>
        </label>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Column Mappings</h2>
            <p className="text-sm text-gray-500">
              Map source fields to database fields. For XML imports, source fields are child nodes inside the configured record node.
            </p>
          </div>
          <button
            type="button"
            onClick={onAddMapping}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
          >
            <Plus className="h-4 w-4" /> Add mapping
          </button>
        </div>

        <div className="space-y-3">
          {formValues.columnMappings.map((mapping, index) => (
            <div
              key={`mapping-${index}`}
              className="grid gap-3 rounded-xl border border-gray-200 bg-gray-50 p-4 md:grid-cols-2 xl:grid-cols-[1fr_1fr_180px_180px_180px_180px_auto]"
            >
              <Field label="Source Field" htmlFor={`source-field-${index}`}>
                <input
                  id={`source-field-${index}`}
                  type="text"
                  value={mapping.sourceField ?? mapping.csvHeader ?? ""}
                  onChange={onMappingChange(index, "sourceField")}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                  placeholder={isXmlParser ? "ProductCode" : "sku"}
                />
              </Field>

              <Field label="Database Field" htmlFor={`database-field-${index}`}>
                <input
                  id={`database-field-${index}`}
                  type="text"
                  value={mapping.databaseField}
                  onChange={onMappingChange(index, "databaseField")}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                  placeholder="productSku"
                />
              </Field>

              <Field label="Target Type" htmlFor={`target-type-${index}`}>
                <select
                  id={`target-type-${index}`}
                  value={mapping.targetType || "string"}
                  onChange={onMappingChange(index, "targetType")}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                >
                  {targetTypeOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label="Seperator"
                htmlFor={`separator-${index}`}
                hint={mapping.targetType === "array" ? "Used to split the incoming value into array items." : "Only used when Target Type is Array."}
              >
                <select
                  id={`separator-${index}`}
                  value={mapping.seperator || ","}
                  onChange={onMappingChange(index, "seperator")}
                  disabled={mapping.targetType !== "array"}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:cursor-not-allowed disabled:bg-gray-100"
                >
                  {separatorOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label="Import Format"
                htmlFor={`import-format-${index}`}
                hint={mapping.targetType === "date" ? "Format of the incoming source value." : "Only used when Target Type is Date."}
              >
                <select
                  id={`import-format-${index}`}
                  value={mapping.importFormat || ""}
                  onChange={onMappingChange(index, "importFormat")}
                  disabled={mapping.targetType !== "date"}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:cursor-not-allowed disabled:bg-gray-100"
                >
                  <option value="">Select import format</option>
                  {dateFormatOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label="Target Format"
                htmlFor={`target-format-${index}`}
                hint={mapping.targetType === "date" ? "Format used when writing the parsed date value." : "Only used when Target Type is Date."}
              >
                <select
                  id={`target-format-${index}`}
                  value={mapping.targetFormat || ""}
                  onChange={onMappingChange(index, "targetFormat")}
                  disabled={mapping.targetType !== "date"}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:cursor-not-allowed disabled:bg-gray-100"
                >
                  <option value="">Select target format</option>
                  {dateFormatOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>

              <div className="flex items-end">
                <button
                  type="button"
                  onClick={() => onRemoveMapping(index)}
                  disabled={formValues.columnMappings.length === 1}
                  className={`inline-flex items-center justify-center rounded-lg border p-2 ${
                    formValues.columnMappings.length === 1
                      ? "cursor-not-allowed border-gray-200 text-gray-400"
                      : "border-red-200 text-red-700 hover:bg-red-50"
                  }`}
                  title="Remove mapping"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium hover:bg-gray-100"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-2 rounded-lg bg-[#b41f1f] text-white text-sm font-semibold hover:bg-[#961919] disabled:opacity-60"
        >
          {saving ? "Saving..." : submitLabel}
        </button>
      </div>
    </form>
  );
}
