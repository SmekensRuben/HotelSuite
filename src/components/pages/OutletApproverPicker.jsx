import React from "react";
import { Combobox } from "../ui/combobox";

const labelFor = (user) =>
  `${user.firstName || ""} ${user.lastName || ""}`.trim() ||
  user.displayName ||
  user.email ||
  "Name unavailable";
export default function OutletApproverPicker({
  users,
  selectedIds,
  onChange,
  disabled,
  loading,
}) {
  const selected = users.filter((user) => selectedIds.includes(user.id));
  return (
    <div className="space-y-3">
      <div>
        <label
          htmlFor="outlet-approver"
          className="mb-2 block text-sm font-medium text-gray-700"
        >
          Approvers
        </label>
        <Combobox
          id="outlet-approver"
          value={null}
          onChange={(user) => {
            if (user) onChange([...selectedIds, user.id]);
          }}
          options={users.filter((user) => !selectedIds.includes(user.id))}
          displayValue={labelFor}
          getOptionValue={(user) => user.id}
          placeholder="Search hotel approvers"
          disabled={disabled}
          loading={loading}
          emptyMessage="No other eligible approvers."
          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
        />
        <p className="mt-2 text-xs text-gray-500">
          Choose hotel members who can approve orders for this outlet.
        </p>
      </div>
      {selected.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {selected.map((user) => (
            <li
              key={user.id}
              className="inline-flex max-w-full items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm"
            >
              <span className="truncate">{labelFor(user)}</span>
              <button
                type="button"
                aria-label={`Remove ${labelFor(user)} as approver`}
                disabled={disabled}
                onClick={() =>
                  onChange(selectedIds.filter((id) => id !== user.id))
                }
                className="font-semibold text-gray-500 disabled:opacity-50"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
