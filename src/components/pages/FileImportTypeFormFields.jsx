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
        id="write-mode"
        label="Write Mode"
        value={formValues.writeMode}
        onChange={onChange("writeMode")}
        placeholder="overwrite"
      />
    </>
  );
}
