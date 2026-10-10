import { describe, expect, it, vi } from "vitest";
import { collectPaginatedProducts } from "./paginatedExport";

describe("complete product export", () => {
  it("exports all 121 records across pages, independently of the current visible filter", async () => {
    const rows = Array.from({ length: 121 }, (_, id) => ({ id: String(id), category: id < 50 ? "Early" : "Later" }));
    const load = vi.fn(async ({ cursor, pageSize, category }) => {
      const filtered = rows.filter((row) => !category || row.category === category);
      const start = cursor || 0;
      return { products: filtered.slice(start, start + pageSize), hasMore: start + pageSize < filtered.length, cursor: start + pageSize };
    });
    expect(await collectPaginatedProducts(load, {}, 50)).toEqual(rows);
    expect(load).toHaveBeenCalledTimes(3);
    expect(load.mock.calls.every(([options]) => options.category === undefined)).toBe(true);
    expect(await collectPaginatedProducts(load, { category: "Later" }, 50)).toEqual(rows.slice(50));
  });
  it("rejects a partial export when a later page fails", async () => {
    const load = vi.fn().mockResolvedValueOnce({ products: [{ id: "1" }], hasMore: true, cursor: "next" }).mockRejectedValue(new Error("Offline"));
    await expect(collectPaginatedProducts(load)).rejects.toThrow("Offline");
  });
  it("fails safely for non-advancing pagination", async () => {
    await expect(collectPaginatedProducts(async () => ({ products: [], hasMore: true, cursor: "same" }))).rejects.toThrow("did not advance");
  });
});
