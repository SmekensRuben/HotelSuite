import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const PREFIX = "hotelsuite.stockCount.draft.v1:";
const CHANGED = "stock-count-draft-changed";
const STORAGE_MESSAGE = "This draft could not be stored on this device. Keep this page open and save your counts, or retry local storage.";
const LEAVING = "stock-count-draft-leaving";
// Failed local writes remain recoverable across SPA navigation. They still
// require an unload warning because a full reload would discard this memory.
const memoryDrafts = new Map();
const memoryDismissals = new Map();
const CLEANUP_MESSAGE = "Device draft cleanup could not be confirmed. The draft is dismissed for this session, but may appear again after reloading.";
const RECOVERY_MESSAGE = "Device draft storage is unavailable. Previously stored drafts may not be visible until storage is available again.";
const warnAboutMemoryDrafts = (event) => {
  if (memoryDrafts.size) { event.preventDefault(); event.returnValue = ""; }
};
function keepInMemory(key, raw) {
  memoryDrafts.set(key, raw);
  window.addEventListener("beforeunload", warnAboutMemoryDrafts);
}
function clearMemory(key) {
  memoryDrafts.delete(key);
  if (!memoryDrafts.size) window.removeEventListener("beforeunload", warnAboutMemoryDrafts);
}

export function confirmStockCountNavigation() {
  return window.dispatchEvent(new Event(LEAVING, { cancelable: true }));
}

function editorId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readDraft(raw, scope) {
  try {
    const draft = JSON.parse(raw);
    if (draft.version !== 1 || draft.scope !== scope || typeof draft.editorId !== "string"
      || !Number.isSafeInteger(draft.baseRevision) || draft.baseRevision < 0
      || !Number.isFinite(draft.updatedAt) || !draft.value || typeof draft.value !== "object") return null;
    return draft;
  } catch { return null; }
}

// Writes happen only through update/recover. Hydrating a server snapshot must
// never replace a recoverable draft. Every mounted editor owns a separate key.
export function useStockCountDraft({ hotelUid, stockCountId, locationId, actorUid, enabled = true }) {
  const scope = enabled && [hotelUid, stockCountId, locationId, actorUid].every(Boolean)
    ? JSON.stringify([actorUid, hotelUid, stockCountId, locationId]) : null;
  const editor = useMemo(() => {
    const id = editorId();
    return { scope, id, prefix: `${PREFIX}${scope}:`, key: `${PREFIX}${scope}:${id}`, current: null, recovered: null, persisted: false };
  }, [scope]);
  const active = useRef(editor);
  active.current = editor;
  const [state, setState] = useState({ editor, recoveries: [], storageError: "", dirty: false, savedLocally: false });
  const currentState = state.editor === editor ? state : { recoveries: [], storageError: "", dirty: false, savedLocally: false };

  const refresh = useCallback(() => {
    if (active.current !== editor) return;
    const recoveries = [];
    let storageError = editor.cleanupError || "";
    if (scope) {
      try {
        for (let index = 0; index < window.localStorage.length; index += 1) {
          const key = window.localStorage.key(index);
          if (!key?.startsWith(editor.prefix) || key === editor.key || key.slice(editor.prefix.length).startsWith("dismiss:")) continue;
          const raw = window.localStorage.getItem(key);
          const draft = readDraft(raw, scope);
          if (draft && !memoryDrafts.has(key) && memoryDismissals.get(key) !== raw
            && window.localStorage.getItem(`${editor.prefix}dismiss:${draft.editorId}`) !== raw) recoveries.push({ ...draft, key, raw });
        }
        recoveries.sort((a, b) => b.updatedAt - a.updatedAt);
        if (editor.current && window.localStorage.getItem(editor.key) !== editor.current) {
          keepInMemory(editor.key, editor.current);
          editor.persisted = false;
          storageError = STORAGE_MESSAGE;
        }
      } catch {
        if (editor.current) keepInMemory(editor.key, editor.current);
        editor.persisted = false; storageError = editor.current ? STORAGE_MESSAGE : editor.cleanupError || RECOVERY_MESSAGE;
      }
      for (const [key, raw] of memoryDrafts) {
        if (!key.startsWith(editor.prefix) || key === editor.key || memoryDismissals.get(key) === raw) continue;
        const draft = readDraft(raw, scope);
        if (draft) recoveries.push({ ...draft, key, raw, memoryOnly: true });
      }
      recoveries.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    setState({ editor, recoveries, storageError, dirty: Boolean(editor.current), savedLocally: Boolean(editor.current && editor.persisted) });
  }, [editor, scope]);

  const persist = useCallback(() => {
    if (!scope || active.current !== editor || !editor.current) return false;
    try {
      window.localStorage.setItem(editor.key, editor.current);
      clearMemory(editor.key);
      editor.persisted = true;
      refresh();
      window.dispatchEvent(new Event(CHANGED));
      return true;
    } catch {
      keepInMemory(editor.key, editor.current);
      editor.persisted = false;
      setState((previous) => ({ ...previous, editor, dirty: true, savedLocally: false, storageError: STORAGE_MESSAGE }));
      return false;
    }
  }, [editor, refresh, scope]);

  const update = useCallback((value, baseRevision = 0) => {
    if (!scope || active.current !== editor) return false;
    editor.cleanupError = "";
    try {
      editor.current = JSON.stringify({ version: 1, scope, editorId: editor.id, value, baseRevision, updatedAt: Date.now() });
    } catch {
      editor.persisted = false;
      setState((previous) => ({ ...previous, editor, dirty: true, savedLocally: false, storageError: STORAGE_MESSAGE }));
      return false;
    }
    return persist();
  }, [editor, persist, scope]);

  const recover = useCallback((draft) => {
    if (!scope || active.current !== editor || !draft || draft.scope !== scope || !readDraft(draft.raw, scope)) return null;
    editor.recovered = { key: draft.key, raw: draft.raw, editorId: draft.editorId };
    update(draft.value, draft.baseRevision);
    return { value: draft.value, baseRevision: draft.baseRevision };
  }, [editor, scope, update]);

  const dismiss = useCallback((draft) => {
    if (!draft || draft.scope !== scope || !readDraft(draft.raw, scope)) return false;
    // Keep another tab's key intact. A dismissal matches only this exact
    // snapshot; later edits in that tab remain independently recoverable.
    memoryDismissals.set(draft.key, draft.raw);
    if (memoryDrafts.get(draft.key) === draft.raw) clearMemory(draft.key);
    try { window.localStorage.setItem(`${editor.prefix}dismiss:${draft.editorId}`, draft.raw); return true; }
    catch { return false; }
  }, [editor, scope]);

  const discard = useCallback((draft) => {
    if (active.current !== editor) return false;
    editor.cleanupError = dismiss(draft) ? "" : CLEANUP_MESSAGE;
    refresh(); window.dispatchEvent(new Event(CHANGED)); return true;
  }, [dismiss, editor, refresh]);

  const clear = useCallback(() => {
    if (active.current !== editor) return false;
    let cleaned = !editor.recovered || dismiss({ ...editor.recovered, scope });
    if (editor.current) memoryDismissals.set(editor.key, editor.current);
    try { window.localStorage.removeItem(editor.key); } catch { cleaned = false; }
    // A confirmed server save must release in-memory loss warnings even when
    // cleaning up the browser's local copy is blocked.
    clearMemory(editor.key);
    editor.current = null;
    editor.recovered = null;
    editor.persisted = false;
    editor.cleanupError = cleaned ? "" : CLEANUP_MESSAGE;
    refresh();
    window.dispatchEvent(new Event(CHANGED));
    return true;
  }, [dismiss, editor, refresh, scope]);

  const canLeave = useCallback(() => !editor.current || editor.persisted
    || window.confirm("Your counts are not saved on this device or to the hotel. Leave and lose these changes?"), [editor]);

  useEffect(() => {
    refresh();
    const beforeUnload = (event) => {
      if (editor.current && !editor.persisted) { event.preventDefault(); event.returnValue = ""; }
    };
    const onLink = (event) => {
      if (event.target?.closest?.("a[href]") && !canLeave()) { event.preventDefault(); event.stopPropagation(); }
    };
    const onLeaving = (event) => { if (!canLeave()) event.preventDefault(); };
    window.addEventListener("storage", refresh);
    window.addEventListener(CHANGED, refresh);
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener(LEAVING, onLeaving);
    document.addEventListener("click", onLink, true);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(CHANGED, refresh);
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener(LEAVING, onLeaving);
      document.removeEventListener("click", onLink, true);
    };
  }, [canLeave, editor, refresh]);

  return { ...currentState, update, recover, discard, clear, retryStorage: persist, canLeave };
}
