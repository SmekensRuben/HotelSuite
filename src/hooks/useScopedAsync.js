import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** Loads one scoped resource and ignores obsolete, unmounted or reversed responses. */
export function useScopedAsync({ scopeKey, enabled = true, initialData = null, retainData = false, load }) {
  const [state, setState] = useState({ scopeKey: null, data: initialData, loading: enabled, error: null });
  const generation = useRef(0);
  const active = useRef(false);
  const lastArguments = useRef([]);
  const currentRequest = useRef({ scopeKey, load, enabled });
  useLayoutEffect(() => { currentRequest.current = { scopeKey, load, enabled }; }, [scopeKey, load, enabled]);
  const run = useCallback(async (...args) => {
    const isCurrent = () => currentRequest.current.scopeKey === scopeKey && currentRequest.current.load === load && currentRequest.current.enabled;
    if (!enabled || !active.current || !isCurrent()) return;
    const request = ++generation.current;
    lastArguments.current = args;
    setState((previous) => ({ scopeKey, data: retainData && previous.scopeKey === scopeKey ? previous.data : initialData, loading: true, error: null }));
    try {
      const data = await load(...args);
      if (active.current && isCurrent() && request === generation.current) {
        setState({ scopeKey, data, loading: false, error: null });
        return data;
      }
    } catch (error) {
      if (active.current && isCurrent() && request === generation.current) {
        setState((previous) => ({ scopeKey, data: retainData && previous.scopeKey === scopeKey ? previous.data : initialData, loading: false, error }));
      }
    }
  }, [scopeKey, enabled, load, retainData]);
  useEffect(() => {
    active.current = true;
    lastArguments.current = [];
    if (enabled) run();
    else setState({ scopeKey, data: initialData, loading: false, error: null });
    return () => { active.current = false; generation.current += 1; };
  }, [run, enabled]);
  const retry = useCallback(() => run(...lastArguments.current), [run]);
  const setData = useCallback((next) => setState((current) => current.scopeKey === scopeKey
    ? { ...current, data: typeof next === "function" ? next(current.data) : next } : current), [scopeKey]);
  return { ...(state.scopeKey === scopeKey ? state : { data: initialData, loading: enabled, error: null }), run, retry, setData };
}
