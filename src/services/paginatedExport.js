/** Fetches the complete scoped result. Callers explicitly choose export filters. */
export async function collectPaginatedProducts(loadPage, filters = {}, pageSize = 200) {
  const products = [];
  const seenCursors = new Set();
  let cursor = null;
  while (true) {
    const result = await loadPage({ ...filters, pageSize, cursor });
    products.push(...(Array.isArray(result?.products) ? result.products : []));
    if (!result?.hasMore) return products;
    if (!result.cursor || seenCursors.has(result.cursor)) throw new Error("Export pagination did not advance. Please retry.");
    seenCursors.add(result.cursor);
    cursor = result.cursor;
  }
}
