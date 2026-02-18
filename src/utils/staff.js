const normalizeIdentifier = value => {
  if (value === undefined || value === null) return "";
  const normalized = `${value}`.trim().toLowerCase();
  return normalized;
};

const collectExtraIdentifiers = extras => {
  const result = [];
  extras.forEach(value => {
    if (Array.isArray(value)) {
      result.push(...collectExtraIdentifiers(value));
    } else if (value !== undefined && value !== null) {
      result.push(value);
    }
  });
  return result;
};

export function getStaffIdentifiers(member, ...extraIdentifiers) {
  const values = [
    ...collectExtraIdentifiers(extraIdentifiers),
    member?.id,
    member?.key,
    member?.name,
    member?.aapiId,
    member?.outletId,
  ];

  const identifiers = new Set();
  values.forEach(value => {
    const normalized = normalizeIdentifier(value);
    if (normalized) {
      identifiers.add(normalized);
    }
  });

  return Array.from(identifiers);
}

export function normalizeTicketChecklist(checklist) {
  if (!Array.isArray(checklist)) return [];
  return checklist
    .map(item => {
      if (!item) return null;
      if (Array.isArray(item)) {
        const [label, checked] = item;
        const normalizedLabel = `${label ?? ""}`.trim();
        if (!normalizedLabel) return null;
        return { label: normalizedLabel, checked: !!checked };
      }
      if (typeof item === "object") {
        const rawLabel =
          typeof item.label === "string"
            ? item.label
            : typeof item.text === "string"
            ? item.text
            : "";
        const label = rawLabel.trim();
        if (!label) return null;
        const checkedValue =
          typeof item.checked === "boolean"
            ? item.checked
            : typeof item.value === "boolean"
            ? item.value
            : false;
        return { label, checked: checkedValue };
      }
      if (typeof item === "string") {
        const label = item.trim();
        if (!label) return null;
        return { label, checked: false };
      }
      return null;
    })
    .filter(Boolean);
}

export function hasIncompleteChecklist(ticket) {
  const items = normalizeTicketChecklist(ticket?.checklist);
  if (items.length === 0) return false;
  return items.some(item => !item.checked);
}

const ticketMatchesIdentifiers = (ticket, identifierSet) => {
  if (!identifierSet || identifierSet.size === 0) return false;
  const cashier = normalizeIdentifier(ticket?.cashier);
  if (!cashier) return false;
  return identifierSet.has(cashier);
};

export function countIncompleteTicketsForStaff(member, tickets = [], ...extraIdentifiers) {
  if (!Array.isArray(tickets) || tickets.length === 0) return 0;
  const identifiers = new Set(getStaffIdentifiers(member, ...extraIdentifiers));
  if (identifiers.size === 0) return 0;
  return tickets.reduce((count, ticket) => {
    if (ticketMatchesIdentifiers(ticket, identifiers) && hasIncompleteChecklist(ticket)) {
      return count + 1;
    }
    return count;
  }, 0);
}

export function getIncompleteTicketsForStaff(member, tickets = [], ...extraIdentifiers) {
  if (!Array.isArray(tickets) || tickets.length === 0) return [];
  const identifiers = new Set(getStaffIdentifiers(member, ...extraIdentifiers));
  if (identifiers.size === 0) return [];
  return tickets.filter(ticket => ticketMatchesIdentifiers(ticket, identifiers) && hasIncompleteChecklist(ticket));
}

export function getTicketChecklistStats(ticket) {
  const items = normalizeTicketChecklist(ticket?.checklist);
  const checked = items.filter(item => item.checked).length;
  return { total: items.length, checked };
}
