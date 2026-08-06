import React, { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { GROUP_NOTIFICATIONS } from "../../constants/groupNotifications";

export default function NotificationListSelector({ lists, value, onChange, disabled = false, readOnly = false }) {
  const [pending, setPending] = useState({});

  useEffect(() => {
    setPending((current) => Object.fromEntries(
      Object.entries(current).filter(([key, listId]) => !(value[key] || []).includes(listId))
    ));
  }, [value]);

  const addList = (notificationKey) => {
    const listId = pending[notificationKey];
    if (!listId) return;
    onChange({ ...value, [notificationKey]: [...(value[notificationKey] || []), listId] });
    setPending((current) => ({ ...current, [notificationKey]: "" }));
  };

  const removeList = (notificationKey, listId) => {
    onChange({ ...value, [notificationKey]: (value[notificationKey] || []).filter((id) => id !== listId) });
  };

  const visibleNotifications = readOnly
    ? GROUP_NOTIFICATIONS.filter(({ key }) => (value[key] || []).some((id) => lists.some((list) => list.id === id)))
    : GROUP_NOTIFICATIONS;

  if (readOnly && visibleNotifications.length === 0) {
    return <p className="text-sm text-gray-500">No Notification Lists added.</p>;
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {visibleNotifications.map((notification) => {
        const selectedIds = value[notification.key] || [];
        const selectedLists = selectedIds.map((id) => lists.find((list) => list.id === id)).filter(Boolean);
        const availableLists = lists.filter((list) => !selectedIds.includes(list.id));

        return (
          <section key={notification.key} className="rounded-xl border border-gray-200 bg-gray-50/60 p-4">
            <h3 className="text-sm font-semibold text-gray-900">{notification.label}</h3>
            <div className="mt-3 space-y-2">
              {selectedLists.length === 0 && <p className="text-sm text-gray-500">No Notification Lists added.</p>}
              {selectedLists.map((list) => (
                <div key={list.id} className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm shadow-sm">
                  <span><span className="font-medium text-gray-900">{list.title}</span><span className="ml-2 text-xs text-gray-500">{list.contacts?.length || 0} contact(s)</span></span>
                  {!readOnly && <button type="button" onClick={() => removeList(notification.key, list.id)} disabled={disabled} aria-label={`Remove ${list.title} from ${notification.label}`} className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-[#b41f1f] disabled:opacity-50"><X className="h-4 w-4" /></button>}
                </div>
              ))}
            </div>
            {!readOnly && (
              <div className="mt-3 flex gap-2">
                <select value={pending[notification.key] || ""} onChange={(event) => setPending((current) => ({ ...current, [notification.key]: event.target.value }))} disabled={disabled || availableLists.length === 0} aria-label={`Notification List for ${notification.label}`} className="min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:bg-gray-100">
                  <option value="">{availableLists.length ? "Select a Notification List" : "All lists added"}</option>
                  {availableLists.map((list) => <option key={list.id} value={list.id}>{list.title}</option>)}
                </select>
                <button type="button" onClick={() => addList(notification.key)} disabled={disabled || !pending[notification.key]} className="inline-flex items-center gap-1 rounded-lg bg-[#b41f1f] px-3 py-2 text-sm font-semibold text-white disabled:bg-gray-300"><Plus className="h-4 w-4" /> Add</button>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
