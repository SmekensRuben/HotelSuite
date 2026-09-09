export function getMembershipLevels(record) {
  const memberships = Array.isArray(record.memberships)
    ? record.memberships
    : Object.values(record.memberships || {});

  return memberships
    .map((membership) => String(membership?.membershipLevel || "").trim())
    .filter(Boolean);
}

function matchesMarketSegment(record, marketSegmentPrefixes) {
  if (!Array.isArray(marketSegmentPrefixes) || marketSegmentPrefixes.length === 0) return true;
  const rateCode = String(record.rateCode || "").trim().toLocaleLowerCase();
  return marketSegmentPrefixes.some((prefix) => rateCode.startsWith(String(prefix || "").trim().toLocaleLowerCase()));
}

export function filterArrivals(records, marketSegmentPrefixes, selectedMemberships) {

  return records.filter((record) => {
    const matchesSegment = matchesMarketSegment(record, marketSegmentPrefixes);
    const membershipLevels = getMembershipLevels(record);
    const matchesMembership = selectedMemberships.length === 0
      || selectedMemberships.some((membership) => membershipLevels.includes(membership));

    return matchesSegment && matchesMembership;
  });
}

export function getReservationCreator(record) {
  return String(record.insertUser || "").trim();
}

export function filterMadeReservations(records, marketSegmentPrefixes, includePms, selectedCreators) {
  return records.filter((record) => {
    const matchesSegment = matchesMarketSegment(record, marketSegmentPrefixes);
    const isPmRoom = ["PR", "PM"].includes(String(record.roomCategoryLabel || "").trim().toUpperCase());
    const matchesCreator = !Array.isArray(selectedCreators)
      || selectedCreators.includes(getReservationCreator(record));

    return matchesSegment && (includePms || !isPmRoom) && matchesCreator;
  });
}
