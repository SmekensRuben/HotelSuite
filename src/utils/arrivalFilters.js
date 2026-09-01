export function getMembershipLevels(record) {
  const memberships = Array.isArray(record.memberships)
    ? record.memberships
    : Object.values(record.memberships || {});

  return memberships
    .map((membership) => String(membership?.membershipLevel || "").trim())
    .filter(Boolean);
}

export function filterArrivals(records, rateCodeSearch, selectedMemberships) {
  const normalizedRateCodeSearch = rateCodeSearch.trim().toLocaleLowerCase();

  return records.filter((record) => {
    const matchesRateCode = !normalizedRateCodeSearch
      || String(record.rateCode || "").toLocaleLowerCase().includes(normalizedRateCodeSearch);
    const membershipLevels = getMembershipLevels(record);
    const matchesMembership = selectedMemberships.length === 0
      || selectedMemberships.some((membership) => membershipLevels.includes(membership));

    return matchesRateCode && matchesMembership;
  });
}

export function filterMadeReservations(records, rateCodeSearch, includePms) {
  const normalizedRateCodeSearch = rateCodeSearch.trim().toLocaleLowerCase();

  return records.filter((record) => {
    const matchesRateCode = !normalizedRateCodeSearch
      || String(record.rateCode || "").toLocaleLowerCase().includes(normalizedRateCodeSearch);
    const isPmRoom = ["PR", "PM"].includes(String(record.roomCategoryLabel || "").trim().toUpperCase());

    return matchesRateCode && (includePms || !isPmRoom);
  });
}
