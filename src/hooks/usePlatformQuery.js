import { useCallback, useEffect, useRef, useState } from "react";

// A hotel/route change fences old responses. Failed reads never become empty success.
export function usePlatformQuery(loader, key) {
  const latest = useRef(loader);
  latest.current = loader;
  const request = useRef(0);
  const currentKey = useRef(key);
  currentKey.current = key;
  const [state, setState] = useState({ key, loading: true, data: null, error: null });
  const refresh = useCallback(async () => {
    if (currentKey.current !== key) return null;
    const attempt = ++request.current;
    setState({ key, loading: true, data: null, error: null });
    try {
      const data = await latest.current();
      if (attempt === request.current && currentKey.current === key) setState({ key, loading: false, data, error: null });
      return data;
    } catch (error) {
      if (attempt === request.current && currentKey.current === key) setState({ key, loading: false, data: null, error });
      return null;
    }
  }, [key]);
  useEffect(() => { refresh(); return () => { request.current++; }; }, [refresh]);
  return { ...(state.key === key ? state : { loading: true, data: null, error: null }), refresh };
}

export function usePlatformScope(key) {
  const live = useRef({ key, active: true });
  if (live.current.key !== key) live.current = { key, active: true };
  useEffect(() => { const scope = live.current; scope.active = true; return () => { scope.active = false; }; }, [key]);
  return () => { const scope = live.current; return () => scope.active && live.current === scope; };
}
