function addDays(dateValue, days) {
  const date = new Date(`${dateValue}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function buildHistoricalDateAnalysis(quoteDates, consideredDates, selectedYears, weekOffsets = {}) {
  return selectedYears.map((year) => {
    const availableDates = consideredDates.filter((item) => item.date.startsWith(`${year}-`));
    const matches = quoteDates.map((quoteDate) => {
      const source = new Date(`${quoteDate}T00:00:00Z`);
      const sameWeekday = availableDates.filter((item) => new Date(`${item.date}T00:00:00Z`).getUTCDay() === source.getUTCDay());
      const target = Date.UTC(Number(year), source.getUTCMonth(), source.getUTCDate());
      const baseline = sameWeekday.sort((left, right) =>
        Math.abs(new Date(`${left.date}T00:00:00Z`).getTime() - target) - Math.abs(new Date(`${right.date}T00:00:00Z`).getTime() - target)
      )[0];
      const shiftedDate = baseline ? addDays(baseline.date, Number(weekOffsets[year] || 0) * 7) : null;
      const consideredDate = availableDates.find((item) => item.date === shiftedDate) || null;
      return {
        quoteDate,
        weekday: source.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }),
        historicalDate: shiftedDate,
        consideredDate,
      };
    });
    return { year, matches };
  });
}
