import React, { useEffect, useRef, useState } from "react";
import { isMeasuredPurchaseUnit } from "../../utils/productUnitDisplay";

/** Finish decimal entry before reserving a cart command. Typing 0.25 must not remove the line at its first 0. */
export default function CartQuantityInput({ quantity, purchaseUnit, revision, disabled, onCommit }) {
  const [draft, setDraft] = useState(String(quantity)), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const editing = useRef(null), alive = useRef(true), latest = useRef({ quantity, revision, onCommit });
  latest.current = { quantity, revision, onCommit };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!editing.current) setDraft(String(quantity)); }, [quantity]);
  const reset = () => { editing.current = null; setDraft(String(latest.current.quantity)); setError(""); };
  const commit = async () => {
    if (disabled || busy || !editing.current) return;
    const value = draft.trim() ? Number(draft) : NaN;
    if (!Number.isFinite(value) || value < 0 || value > 100000 || Math.abs(value * 1000 - Math.round(value * 1000)) > 1e-8) {
      setError("Enter a quantity with up to three decimals. Blank is unknown."); return;
    }
    if (value === quantity) { reset(); return; }
    setBusy(true); setError("");
    try {
      if (await latest.current.onCommit(value, editing.current.revision)) { if (alive.current) reset(); }
      else if (alive.current) setError("The quantity could not be confirmed. Resolve the saved request or use the latest quantity.");
    } catch { if (alive.current) setError("The quantity could not be confirmed. Resolve the saved request before changing it."); }
    finally { if (alive.current) setBusy(false); }
  };
  return <div className="max-w-48"><input type="number" aria-label={`Quantity in ${purchaseUnit}`} title="Press Enter or leave the field to save. Zero removes the line."
    min={isMeasuredPurchaseUnit(purchaseUnit) ? "0.001" : "1"} step={isMeasuredPurchaseUnit(purchaseUnit) ? "0.001" : "1"}
    disabled={disabled || busy} value={draft} className="w-20 rounded border border-gray-300 px-2 py-1"
    onChange={(event) => { editing.current ||= { revision }; setDraft(event.target.value); setError(""); }} onBlur={commit}
    onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } else if (event.key === "Escape") reset(); }} />
    {error && <div role="alert" className="mt-1 text-xs text-red-700"><p>{error}</p><button type="button" disabled={disabled || busy} className="mt-1 underline" onClick={reset}>Use latest quantity</button></div>}
  </div>;
}
