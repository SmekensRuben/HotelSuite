import React from "react";

export const outletInventoryRoleLabel = (role) => role === "central_storage" ? "Central stock point" : "Outlet";

export default function OutletInventoryRoleField({ value, onChange, disabled }) {
  return <fieldset className="space-y-3" disabled={disabled}>
    <legend className="text-sm font-medium text-gray-700">Stock point type</legend>
    <div className="grid gap-3 sm:grid-cols-2">
      {[
        { value: "outlet", title: "Outlet", description: "Count the outlet as a whole. Add locations only when more detail helps." },
        { value: "central_storage", title: "Central stock point", description: "Receive deliveries here, then record requisitions to other outlets." },
      ].map((option) => <label key={option.value} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 ${value === option.value ? "border-brand-800 bg-brand-50" : "border-gray-200"} ${disabled ? "cursor-default opacity-60" : ""}`}>
        <input type="radio" name="inventory-role" className="mt-1" value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
        <span><span className="block text-sm font-semibold">{option.title}</span><span className="mt-1 block text-xs leading-5 text-gray-600">{option.description}</span></span>
      </label>)}
    </div>
  </fieldset>;
}
