import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { auth } from "../firebaseConfig";
import { getCatalogProducts } from "../services/firebaseProducts";

const cursorKey = (cursor) => cursor?.ref?.path || (Number.isSafeInteger(cursor?.offset) ? `offset:${cursor.offset}` : cursor?.id);

/** Browse a bounded page only after opening the picker; typing restarts the cursor. */
export function usePagedCatalogChoices({ hotelUid, scopeKey, enabled }) {
  const actor = auth.currentUser;
  const [query, setQuery] = useState(""), [opened, setOpened] = useState(false), [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([scopeKey, query.trim().toLowerCase()]);
  const [state, setState] = useState({ key: null, actor: null, products: [], loading: false, error: null, hasMore: false, cursor: null });
  const generation = useRef(0), current = useRef({ key, actor, enabled }), seenCursors = useRef(new Set());
  useLayoutEffect(() => { current.current = { key, actor, enabled }; }, [key, actor, enabled]);
  const readPage = useCallback(async (cursor, previous = []) => {
    const matches = () => current.current.key === key && current.current.actor === actor
      && current.current.enabled && auth.currentUser === actor;
    if (!enabled || !matches()) return;
    if (!cursor) seenCursors.current.clear();
    const request = ++generation.current;
    setState({ key, actor, products: previous, loading: true, error: null, hasMore: false, cursor: null });
    try {
      const page = await getCatalogProducts(hotelUid, { pageSize: 25, searchTerm: query.trim(), ...(cursor ? { cursor } : {}), scopeKey });
      if (!Array.isArray(page?.products) || page.products.length > 25 || typeof page.hasMore !== "boolean"
        || (page.hasMore && (!cursorKey(page.cursor) || cursorKey(page.cursor) === cursorKey(cursor) || seenCursors.current.has(cursorKey(page.cursor))))) {
        throw new Error("Catalog choices returned invalid pagination. Retry the search.");
      }
      if (matches() && request === generation.current) {
        const products = [...new Map([...previous, ...page.products].map((product) => [product.id, product])).values()];
        if (page.cursor) seenCursors.current.add(cursorKey(page.cursor));
        const bounded = products.length >= 500 && page.hasMore;
        setState({ key, actor, products: products.slice(0, 500), loading: false, error: null,
          hasMore: page.hasMore && !bounded, cursor: page.cursor, bounded });
      }
    } catch (error) {
      if (matches() && request === generation.current) setState({ key, actor, products: [], loading: false, error, hasMore: false, cursor: null });
    }
  }, [key, actor, enabled, hotelUid, query, scopeKey]);
  useEffect(() => { setOpened(false); setQuery(""); }, [scopeKey, actor]);
  useEffect(() => {
    generation.current += 1;
    if (!opened || !enabled) return;
    const timer = setTimeout(() => readPage(null), query.trim() ? 250 : 0);
    return () => { clearTimeout(timer); generation.current += 1; };
  }, [opened, enabled, readPage, attempt, query]);
  const visible = state.key === key && state.actor === actor && enabled
    ? state : { products: [], loading: Boolean(opened && enabled), error: null, hasMore: false, cursor: null };
  return { ...visible, query,
    search: (value) => { setOpened(true); setQuery(value); },
    retry: () => setAttempt((value) => value + 1),
    loadMore: () => { if (!visible.loading && visible.hasMore) return readPage(visible.cursor, visible.products); },
  };
}
