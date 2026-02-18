import React from 'react';
import { useTranslation } from "react-i18next";


export default function FilterSortControls({ filter, onFilterChange, sortKey, onSortChange }) {
  const { t } = useTranslation("app");
  
  return (
    <div className="mb-4 flex flex-wrap gap-2">
      <input
        type="text"
        className="border rounded px-3 py-1"
        placeholder={t("searchPlaceholder")}
        value={filter}
        onChange={(e) => onFilterChange(e.target.value)}
      />
      <select
        className="border rounded px-2 py-1"
        value={sortKey}
        onChange={(e) => onSortChange(e.target.value)}
      >
        <option value="room">{t("sortRoom")}</option>
        <option value="name">{t("sortName")}</option>
        <option value="membership">{t("sortMembership")}</option>
      </select>
    </div>
  );
}
