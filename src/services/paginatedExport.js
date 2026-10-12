/** Fetches the complete scoped result. Callers explicitly choose export filters. */
export async function collectPaginatedProducts(loadPage, filters = {}, pageSize = 200) {
  const products = [];
  const seenCursors = new Set();
  let cursor = null;
  for (let page = 0; page < 200; page += 1) {
    const result = await loadPage({ ...filters, pageSize, cursor });
    if (!Array.isArray(result?.products) || typeof result.hasMore !== "boolean") throw new Error("Export page response is invalid. Please retry.");
    products.push(...result.products);
    if (!result?.hasMore) return products;
    const cursorKey = result.cursor?.ref?.path || (Number.isSafeInteger(result.cursor?.offset)
      ? `offset:${result.cursor.offset}` : result.cursor?.id || result.cursor);
    if (!cursorKey || seenCursors.has(cursorKey)) throw new Error("Export pagination did not advance. Please retry.");
    seenCursors.add(cursorKey);
    cursor = result.cursor;
  }
  throw new Error("Export exceeded 200 pages. Narrow the selection before exporting.");
}
