function addDays(dateValue, days) {
  const date = new Date(`${dateValue}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function calculateDisplacementMetrics({ averageRoomRate, calculatedOccRooms, calculatedInventoryRooms, requestedGroupRooms, inflationPercentage, displacementThresholdPercentage, yearsAgo, displacedRoomsOverride }) {
  const adjustedAverageRoomRate = Number(averageRoomRate || 0)
    * ((1 + Number(inflationPercentage || 0) / 100) ** Number(yearsAgo || 0));
  const rawDisplacedRooms = (Number(calculatedOccRooms || 0) + Number(requestedGroupRooms || 0))
    - (Number(calculatedInventoryRooms || 0) * (1 - Number(displacementThresholdPercentage || 0) / 100));
  const displacedRooms = Number.isFinite(displacedRoomsOverride)
    ? Math.max(0, Math.min(Number(requestedGroupRooms || 0), displacedRoomsOverride))
    : Math.max(0, Math.ceil(rawDisplacedRooms));
  return {
    adjustedAverageRoomRate,
    displacedRooms,
    displacedRevenue: adjustedAverageRoomRate * displacedRooms,
  };
}

export function calculateAnalysisSummary(analysis, { totalRequestedRooms, roomVatPercentage, breakfastAllocation, breakfastIncluded }) {
  const displacementByYear = analysis.map(({ year, matches }) => ({
    year,
    totalDisplacement: matches.reduce((total, match) => total + Number(match.displacedRevenue || 0), 0),
  }));
  const averageDisplacement = displacementByYear.length
    ? displacementByYear.reduce((total, item) => total + item.totalDisplacement, 0) / displacementByYear.length
    : 0;
  const roomRevenuePerRequestedRoom = totalRequestedRooms > 0 ? averageDisplacement / totalRequestedRooms : 0;
  const profitablePrice = roomRevenuePerRequestedRoom * (1 + Number(roomVatPercentage || 0) / 100)
    + (breakfastIncluded ? Number(breakfastAllocation || 0) : 0);
  return { displacementByYear, averageDisplacement, profitablePrice };
}

export function buildHistoricalDateAnalysis(quoteDates, consideredDates, selectedYears, weekOffsets = {}, options = {}) {
  const quoteYear = Number(options.quoteYear || quoteDates[0]?.slice(0, 4) || 0);
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
      const requestedGroupRooms = Number(options.requestedRoomsByDate?.[quoteDate] || 0);
      const metrics = calculateDisplacementMetrics({
        averageRoomRate: consideredDate?.averageRoomRate,
        calculatedOccRooms: consideredDate?.calculatedOccRooms,
        calculatedInventoryRooms: consideredDate?.calculatedInventoryRooms,
        requestedGroupRooms,
        inflationPercentage: options.inflationPercentage,
        displacementThresholdPercentage: options.displacementThresholdPercentage,
        yearsAgo: Math.max(0, quoteYear - Number(year)),
        displacedRoomsOverride: options.displacedRoomsByDate?.[quoteDate],
      });
      return {
        quoteDate,
        weekday: source.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }),
        historicalDate: shiftedDate,
        consideredDate,
        requestedGroupRooms,
        ...metrics,
      };
    });
    return { year, matches };
  });
}
