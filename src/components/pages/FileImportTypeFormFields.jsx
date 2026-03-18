import React from "react";

function TextField({ id, label, value, onChange, required = false, placeholder = "" }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-gray-700 mb-1">
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={onChange}
        required={required}
        placeholder={placeholder}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
      />
    </div>
  );
}

export default function FileImportTypeFormFields({ formValues, onChange }) {
  return (
    <>
      <TextField
        id="file-type"
        label="File Type"
        value={formValues.fileType}
        onChange={onChange("fileType")}
        required
        placeholder="csv"
      />

      <TextField
        id="parser-type"
        label="Parser Type"
        value={formValues.parserType}
        onChange={onChange("parserType")}
        placeholder="csv"
      />

      <TextField
        id="delimiter"
        label="Delimiter"
        value={formValues.delimiter}
        onChange={onChange("delimiter")}
        placeholder=","
      />

      <div className="grid gap-4 md:grid-cols-2">
        <label className="flex items-center justify-between rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700">
          <span>Has Header Row</span>
          <input
            type="checkbox"
            checked={formValues.hasHeaderRow}
            onChange={onChange("hasHeaderRow")}
            className="h-4 w-4 rounded border-gray-300 text-[#b41f1f] focus:ring-[#b41f1f]"
          />
        </label>

        <label className="flex items-center justify-between rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700">
          <span>Enabled</span>
          <input
            type="checkbox"
            checked={formValues.enabled}
            onChange={onChange("enabled")}
            className="h-4 w-4 rounded border-gray-300 text-[#b41f1f] focus:ring-[#b41f1f]"
          />
        </label>
      </div>

      <TextField
        id="target-collection"
        label="Target Collection"
        value={formValues.targetCollection}
        onChange={onChange("targetCollection")}
        placeholder="reservations"
      />

      <TextField
        id="target-path"
        label="Target Path"
        value={formValues.targetPath}
        onChange={onChange("targetPath")}
        placeholder="imports/reservations"
      />

      <TextField
        id="write-mode"
        label="Write Mode"
        value={formValues.writeMode}
        onChange={onChange("writeMode")}
        placeholder="overwrite"
      />

      <div className="space-y-3 rounded-xl border border-gray-200 bg-gray-50 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Column Mappings</h2>
            <p className="text-xs text-gray-500">
              Map CSV headers to destination database fields.
            </p>
          </div>
          <button
            type="button"
            onClick={onChange("addColumnMapping")}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
          >
            Add Mapping
          </button>
        </div>

        <div className="space-y-3">
          {formValues.columnsMappings.map((mapping, index) => (
            <div
              key={`column-mapping-${index}`}
              className="grid gap-3 rounded-lg border border-gray-200 bg-white p-3 md:grid-cols-[1fr_1fr_auto]"
            >
              <TextField
                id={`csv-header-${index}`}
                label="CSV Header"
                value={mapping.csvHeader}
                onChange={onChange("columnMappingField", index, "csvHeader")}
                placeholder="reservation_id"
              />

              <TextField
                id={`database-field-${index}`}
                label="Database Field"
                value={mapping.databaseField}
                onChange={onChange("columnMappingField", index, "databaseField")}
                placeholder="reservationId"
              />

              <div className="flex items-end">
                <button
                  type="button"
                  onClick={onChange("removeColumnMapping", index)}
                  className="w-full rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 md:w-auto"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}

          {formValues.columnsMappings.length === 0 && (
            <p className="rounded-lg border border-dashed border-gray-300 bg-white px-3 py-4 text-sm text-gray-500">
              No column mappings configured yet.
            </p>
          )}
        </div>
      </div>
    </>
  );
}
