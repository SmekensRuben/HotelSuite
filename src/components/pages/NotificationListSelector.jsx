import React from "react";
import { GROUP_NOTIFICATIONS } from "../../constants/groupNotifications";

export default function NotificationListSelector({ lists, value, onChange, disabled = false }) {
  const toggle = (notificationKey, listId) => {
    const current = value[notificationKey] || [];
    onChange({
      ...value,
      [notificationKey]: current.includes(listId)
        ? current.filter((id) => id !== listId)
        : [...current, listId],
    });
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {GROUP_NOTIFICATIONS.map((notification) => (
        <fieldset key={notification.key} className="rounded-xl border border-gray-200 bg-gray-50/60 p-4">
          <legend className="px-1 text-sm font-semibold text-gray-900">{notification.label}</legend>
          {lists.length === 0 ? (
            <p className="mt-2 text-sm text-gray-500">No Notification Lists available.</p>
          ) : (
            <div className="mt-2 space-y-2">
              {lists.map((list) => (
                <label key={list.id} className="flex cursor-pointer items-start gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={(value[notification.key] || []).includes(list.id)}
                    onChange={() => toggle(notification.key, list.id)}
                    disabled={disabled}
                    className="mt-0.5 h-4 w-4 rounded border-gray-300 accent-[#b41f1f]"
                  />
                  <span><span className="font-medium">{list.title}</span><span className="block text-xs text-gray-500">{list.contacts?.length || 0} contact(s)</span></span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
      ))}
    </div>
  );
}
