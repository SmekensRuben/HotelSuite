import { describe, expect, it } from "vitest";
import { aggregatePickupRows } from "./firebasePickup";

describe("aggregatePickupRows", () => {
  it("sums marketCodes per day and splits past/future sources", () => {
    const rows = aggregatePickupRows({
      statisticsEntries: [
        {
          daterange: "2026-03-01",
          marketCodes: [
            { roomsSold: 2, totalRevenue: 300 },
            { roomsSold: 3, totalRevenue: 450 },
          ],
        },
        {
          daterange: "2026-03-22",
          marketCodes: [{ roomsSold: 9, totalRevenue: 999 }],
        },
      ],
      forecastEntries: [
        {
          daterange: "2026-03-22",
          marketCodes: [
            { roomsSold: 4, totalRevenue: 500 },
            { roomsSold: 1, totalRevenue: 125 },
          ],
        },
        {
          daterange: "2026-03-23",
          marketCodes: [{ roomsSold: 2, totalRevenue: 200 }],
        },
      ],
      monthStart: "2026-03-01",
      monthEnd: "2026-03-31",
      todayIso: "2026-03-22",
    });

    expect(rows).toHaveLength(31);
    expect(rows[0]).toEqual({
      date: "2026-03-01",
      roomsSold: 5,
      totalRevenue: 750,
      source: "reservationstatistics",
    });
    expect(rows[21]).toEqual({
      date: "2026-03-22",
      roomsSold: 5,
      totalRevenue: 625,
      source: "reservationforecast",
    });
    expect(rows[22]).toEqual({
      date: "2026-03-23",
      roomsSold: 2,
      totalRevenue: 200,
      source: "reservationforecast",
    });
  });

  it("fills missing days with zeros", () => {
    const rows = aggregatePickupRows({
      statisticsEntries: [],
      forecastEntries: [],
      monthStart: "2026-02-01",
      monthEnd: "2026-02-03",
      todayIso: "2026-02-02",
    });

    expect(rows).toEqual([
      { date: "2026-02-01", roomsSold: 0, totalRevenue: 0, source: "reservationstatistics" },
      { date: "2026-02-02", roomsSold: 0, totalRevenue: 0, source: "reservationforecast" },
      { date: "2026-02-03", roomsSold: 0, totalRevenue: 0, source: "reservationforecast" },
    ]);
  });
});
