import React, { useCallback, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Plus } from "lucide-react";
import DataListTable from "../shared/DataListTable";
import { Card } from "../layout/Card";
import { usePermission } from "../../hooks/usePermission";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { ArticleRowsSkeleton } from "../ui/ResourceLoading";

/** One active settings section; resource reads retain their own permission boundary. */
export default function ProcurementResourceSettingsSection({ scope, feature, singular, title, description, loadRecords }) {
  const { hotelUid, scopeKey, current } = scope;
  const navigate = useNavigate();
  const canRead = usePermission(feature, "read");
  const canCreate = usePermission(feature, "create");
  const [search, setSearch] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const load = useCallback(async () => {
    const records = await loadRecords(hotelUid, { includeArchived: true });
    if (!current()) throw new Error("Hotel access changed. Reload settings.");
    return records;
  }, [hotelUid, current, loadRecords]);
  const query = useScopedAsync({ scopeKey, enabled: Boolean(hotelUid && canRead), load });
  const rows = useMemo(() => (query.data || []).filter((item) =>
    (includeArchived || item.archived !== true) && String(item.name || "").toLowerCase().includes(search.trim().toLowerCase())),
  [query.data, search, includeArchived]);
  if (!canRead) return null;
  return <section aria-label={title} className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-xl font-semibold">{title}</h2>
        <p className="mt-1 max-w-2xl text-sm text-gray-600">{description}</p>
      </div>
      {canCreate && <button type="button" onClick={() => navigate(`/settings/${feature}/new`)}
        className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-brand-800 px-3.5 py-2 text-sm font-semibold text-white">
        <Plus className="h-4 w-4" aria-hidden="true" />Add {singular}
      </button>}
    </div>
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1 sm:max-w-md">
          <label htmlFor={`${feature}-search`} className="sr-only">Search {feature}</label>
          <input id={`${feature}-search`} value={search} onChange={(event) => setSearch(event.target.value)}
            placeholder={`Search by ${singular.toLowerCase()} name`} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <label className="flex shrink-0 items-center gap-2 text-sm text-gray-600">
          <input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} />Show archived
        </label>
      </div>
      {query.loading ? <ArticleRowsSkeleton rows={3} label={`Preparing ${feature}…`} />
        : query.error ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <p>{query.error.message || `Unable to load ${feature}.`}</p>
          <button type="button" className="mt-2 underline" onClick={query.retry}>Retry {feature}</button>
        </div> : <DataListTable columns={[
          { key: "name", label: "Name", render: (item) => <Link to={`/settings/${feature}/${item.id}`} onClick={(event) => event.stopPropagation()} className="font-medium text-brand-900 underline-offset-4 hover:underline focus-visible:rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-800">{item.name}</Link> },
          { key: "archived", label: "Status", render: (item) => <span className={`rounded-full px-2.5 py-1 text-xs ${item.archived === true ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-800"}`}>{item.archived === true ? "Archived" : "Active"}</span> },
          { key: "open", label: "", sortable: false, render: () => <ArrowRight className="ml-auto h-4 w-4 text-gray-400" aria-hidden="true" /> },
        ]} rows={rows} emptyMessage={`No ${feature} found.`} onRowClick={(row) => navigate(`/settings/${feature}/${row.id}`)} />}
      <p className="border-t border-gray-100 pt-3 text-xs text-gray-500">Archived {feature} stay available in historical records and are excluded from new workflows.</p>
    </Card>
  </section>;
}
