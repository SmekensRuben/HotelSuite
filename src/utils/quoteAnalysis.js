export function buildHistoricalDateAnalysis(quoteDates, consideredDates, selectedYears) {
  return selectedYears.map((year) => {
    const availableDates = consideredDates.filter((date) => date.startsWith(`${year}-`));
    const matches = quoteDates.map((quoteDate) => {
      const source = new Date(`${quoteDate}T00:00:00Z`);
      const sameWeekday = availableDates.filter((date) => new Date(`${date}T00:00:00Z`).getUTCDay() === source.getUTCDay());
      const target = Date.UTC(Number(year), source.getUTCMonth(), source.getUTCDate());
      const historicalDate = sameWeekday.sort((left, right) =>
        Math.abs(new Date(`${left}T00:00:00Z`).getTime() - target) - Math.abs(new Date(`${right}T00:00:00Z`).getTime() - target)
      )[0] || null;
      return { quoteDate, historicalDate };
    });
    return { year, matches };
  });
}
