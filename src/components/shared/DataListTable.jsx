import React, { useMemo, useState } from "react";

function getComparableValue(row, column) {
  const raw = column.sortValue ? column.sortValue(row) : row[column.key];
  if (typeof raw === "string") return raw.toLowerCase();
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (raw === null || raw === undefined) return "";
  return raw;
}

export default function DataListTable({ columns, rows, onRowClick, emptyMessage = "Geen resultaten." }) {
  const defaultSortColumn = columns.find((column) => column.sortable !== false);
  const [sortConfig, setSortConfig] = useState(
    defaultSortColumn ? { key: defaultSortColumn.key, direction: "asc" } : null
  );

  const sortedRows = useMemo(() => {
    if (!sortConfig) return rows;
    const column = columns.find((item) => item.key === sortConfig.key);
    if (!column) return rows;

    const nextRows = [...rows];
    nextRows.sort((a, b) => {
      const aValue = getComparableValue(a, column);
      const bValue = getComparableValue(b, column);
      if (aValue < bValue) return sortConfig.direction === "asc" ? -1 : 1;
      if (aValue > bValue) return sortConfig.direction === "asc" ? 1 : -1;
      return 0;
    });
    return nextRows;
  }, [columns, rows, sortConfig]);

  const handleSort = (columnKey) => {
    setSortConfig((prev) => {
      if (prev?.key === columnKey) {
        return { key: columnKey, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      return { key: columnKey, direction: "asc" };
    });
  };

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              {columns.map((column) => {
                const isSortable = column.sortable !== false;
                const isActive = sortConfig?.key === column.key;
                return (
                  <th
                    key={column.key}
                    className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500"
                  >
                    {isSortable ? (
                      <button
                        type="button"
                        onClick={() => handleSort(column.key)}
                        className="inline-flex items-center gap-1 hover:text-gray-700"
                      >
                        <span>{column.label}</span>
                        <span className="text-[10px]">
                          {isActive ? (sortConfig.direction === "asc" ? "▲" : "▼") : "↕"}
                        </span>
                      </button>
                    ) : (
                      column.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {sortedRows.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-sm text-gray-500" colSpan={columns.length}>
                  {emptyMessage}
                </td>
              </tr>
            )}
            {sortedRows.map((row) => (
              <tr
                key={row.id}
                onClick={() => onRowClick && onRowClick(row)}
                className={onRowClick ? "cursor-pointer hover:bg-red-50 transition-colors" : ""}
              >
                {columns.map((column) => (
                  <td key={`${row.id}-${column.key}`} className="px-4 py-3 text-sm text-gray-700">
                    {column.render ? column.render(row) : row[column.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
