import React from "react";
import { Plus, Trash2 } from "lucide-react";

const defaultMapping = {
  csvHeader: "",
  databaseField: "",
};

export const initialFileImportTypeValues = {
  fileType: "csv",
  parserType: "csv",
  delimiter: ",",
  hasHeaderRow: true,
  targetCollection: "",
  targetPath: "",
  writeMode: "overwrite",
  enabled: true,
  columnMappings: [defaultMapping],
};

function Field({ label, htmlFor, children }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-gray-700 mb-1">
        {label}
      </label>
      {children}
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
          <input
            id="parser-type"
            type="text"
            value={formValues.parserType}
            onChange={onChange("parserType")}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            placeholder="csv"
          />
        </Field>

        <Field label="Delimiter" htmlFor="delimiter">
          <input
            id="delimiter"
            type="text"
            value={formValues.delimiter}
            onChange={onChange("delimiter")}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            placeholder=","
          />
        </Field>

        <Field label="Target Collection" htmlFor="target-collection">
          <input
            id="target-collection"
            type="text"
            value={formValues.targetCollection}
            onChange={onChange("targetCollection")}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            placeholder="inventory"
          />
        </Field>

        <Field label="Target Path" htmlFor="target-path">
          <input
            id="target-path"
            type="text"
            value={formValues.targetPath}
            onChange={onChange("targetPath")}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            placeholder="products/items"
          />
        </Field>

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
        <label className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
          <input
            type="checkbox"
            checked={formValues.hasHeaderRow}
            onChange={onToggle("hasHeaderRow")}
            className="h-4 w-4 rounded border-gray-300 text-[#b41f1f]"
          />
          <span className="text-sm font-medium text-gray-700">Has Header Row</span>
        </label>

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
            <p className="text-sm text-gray-500">Map CSV headers to database fields.</p>
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
            <div key={`mapping-${index}`} className="grid gap-3 rounded-xl border border-gray-200 bg-gray-50 p-4 md:grid-cols-[1fr_1fr_auto]">
              <Field label="CSV Header" htmlFor={`csv-header-${index}`}>
                <input
                  id={`csv-header-${index}`}
                  type="text"
                  value={mapping.csvHeader}
                  onChange={onMappingChange(index, "csvHeader")}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                  placeholder="sku"
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
