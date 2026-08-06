export const GROUP_NOTIFICATIONS = [
  { key: "roomingListSubmitted", label: "Rooming List Submitted" },
  { key: "changesSubmitted", label: "Changes Submitted" },
  { key: "deadlineMissed", label: "Deadline Missed" },
  { key: "routineReminderSent", label: "Routine Reminder Sent" },
  { key: "postDeadlineChanges", label: "Post-Deadline Changes" },
];

export function normalizeNotificationSelections(value = {}) {
  return Object.fromEntries(
    GROUP_NOTIFICATIONS.map(({ key }) => [
      key,
      Array.isArray(value?.[key]) ? [...new Set(value[key].map(String).filter(Boolean))] : [],
    ])
  );
}
