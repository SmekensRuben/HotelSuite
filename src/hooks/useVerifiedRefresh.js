import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { auth } from "../firebaseConfig";

/** Keep this view's verified data during refresh, never across authority or failed reads. */
export function useVerifiedRefresh({ scopeKey, enabled = true, load }) {
  const actor = auth.currentUser;
  const [state, setState] = useState({ key: null, actor: null, data: null, loading: enabled, error: null });
  const sequence = useRef(0), mounted = useRef(false);
  const current = useRef({ scopeKey, actor, enabled, load });
  useLayoutEffect(() => { current.current = { scopeKey, actor, enabled, load }; }, [scopeKey, actor, enabled, load]);
  const refresh = useCallback(async () => {
    const matches = () => mounted.current && current.current.scopeKey === scopeKey
      && current.current.actor === actor && current.current.load === load
      && current.current.enabled && auth.currentUser === actor;
    if (!enabled || !matches()) return;
    const request = ++sequence.current;
    setState((previous) => ({ key: scopeKey, actor, data: previous.key === scopeKey && previous.actor === actor ? previous.data : null, loading: true, error: null }));
    try {
      const data = await load();
      if (matches() && request === sequence.current) {
        setState({ key: scopeKey, actor, data, loading: false, error: null });
        return data;
      }
    } catch (error) {
      if (matches() && request === sequence.current) setState({ key: scopeKey, actor, data: null, loading: false, error });
    }
  }, [scopeKey, actor, enabled, load]);
  useEffect(() => {
    mounted.current = true;
    if (enabled) refresh();
    else setState({ key: scopeKey, actor, data: null, loading: false, error: null });
    return () => { mounted.current = false; sequence.current += 1; };
  }, [refresh, enabled, scopeKey, actor]);
  const shown = state.key === scopeKey && state.actor === actor && enabled
    ? state : { data: null, loading: enabled, error: null };
  return { ...shown, refreshing: Boolean(shown.loading && shown.data), retry: refresh };
}
