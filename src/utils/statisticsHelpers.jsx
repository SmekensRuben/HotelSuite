export function generateShiftData(guests) {
  const now = Date.now();
  const date = new Date().toISOString().split("T")[0];

  const guestCheckins = {};
  let total = 0;
  let checked = 0;
  let included = 0;
  let excluded = 0;
  let highMembers = 0;
  let nonVipIncluded = 0;
  let includedCheckedIn = 0;
  let excludedCheckedIn = 0;

  const checkinsPerInterval = {};

  for (const g of guests) {
    const guestId = g.id;
    const adults = g.adults || 1;
    total += adults;

    const isVip = ["P6", "X4", "X5"].includes((g.membership || "").toUpperCase());
    const originalStatus = g.status;
    const isIncluded = isVip || originalStatus === "included";
    const isExcluded = !isVip && originalStatus === "excluded";

    const snapshot = {
      room: g.room,
      status: originalStatus,
      membership: g.membership,
      adults: adults,
      checked: !!g.checked,
      checkin_time: g.timestamp || null,
      stay_duration: g.stay_duration || null,
    };

    guestCheckins[guestId] = snapshot;

    if (isVip) highMembers += adults;
    if (isIncluded) included += adults;
    if (isExcluded) excluded += adults;
    if (!isVip && originalStatus === "included") nonVipIncluded += adults;

    if (snapshot.checked) {
      checked += adults;

      if (isIncluded) includedCheckedIn += adults;
      if (isExcluded) excludedCheckedIn += adults;

      if (snapshot.checkin_time) {
        const d = new Date(snapshot.checkin_time);
        const h = d.getHours().toString().padStart(2, "0");
        const m = Math.floor(d.getMinutes() / 15) * 15;
        const label = `${h}:${m.toString().padStart(2, "0")}`;
        checkinsPerInterval[label] = (checkinsPerInterval[label] || 0) + adults;
      }
    }
  }

  const summary = {
    total_guests: total,
    total_checked_in: checked,
    high_member_count: highMembers,
    included_count: included,
    included_checked_in: includedCheckedIn,
    excluded_count: excluded,
    excluded_checked_in: excludedCheckedIn,
    non_member_included: nonVipIncluded,
    checkins_per_interval: checkinsPerInterval,
    total_adults: total,
    closed: true,
    closed_at: now,
  };

  return { date, guestCheckins, summary };
}