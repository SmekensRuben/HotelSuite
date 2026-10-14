import React, { useEffect, useRef, useState } from "react";

/** Camera access is requested only after an explicit tap; keyboard scanners work as text input. */
export default function StockCountBarcodeScanner({ onScan, onClose, disabled = false, scopeKey }) {
  const [barcode, setBarcode] = useState(""), [camera, setCamera] = useState(false), [error, setError] = useState(""), [cameraHint, setCameraHint] = useState("");
  const video = useRef(null), currentScan = useRef(onScan);
  currentScan.current = onScan;
  const cameraSupported = typeof window.BarcodeDetector === "function" && typeof navigator.mediaDevices?.getUserMedia === "function";
  useEffect(() => { setCamera(false); setBarcode(""); setError(""); setCameraHint(""); }, [scopeKey]);
  useEffect(() => {
    if (!camera || disabled || !cameraSupported) return;
    let active = true, stream = null, frame = null;
    const stop = () => { stream?.getTracks().forEach((track) => track.stop()); if (frame != null) cancelAnimationFrame(frame); };
    const run = async () => {
      try {
        const supported = await window.BarcodeDetector.getSupportedFormats?.();
        if (!active) return;
        const formats = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "qr_code"].filter((format) => !supported || supported.includes(format));
        if (!formats.length) throw new Error("This camera cannot read supported product barcodes. Type a barcode or use a handheld scanner.");
        const detector = new window.BarcodeDetector({ formats });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        if (!active) { stop(); return; }
        video.current.srcObject = stream;
        await video.current.play();
        if (!active) return;
        const detect = async () => {
          if (!active) return;
          try {
            if (video.current?.readyState >= 2) {
              const results = await detector.detect(video.current);
              if (!active) return;
              const values = [...new Set(results.map((result) => result.rawValue?.trim()).filter(Boolean))];
              setCameraHint(values.length > 1 ? "Multiple barcodes are in view. Aim at one product barcode." : "");
              if (values.length === 1) { active = false; stop(); setCamera(false); currentScan.current(values[0]); return; }
            }
            frame = requestAnimationFrame(detect);
          } catch { if (active) { stop(); setCamera(false); setError("The camera could not read this barcode. Type it or use a handheld scanner."); } }
        };
        frame = requestAnimationFrame(detect);
      } catch (failure) {
        if (active) { stop(); setCamera(false); setError(failure.name === "NotAllowedError" ? "Camera access was declined. Type a barcode or use a handheld scanner." : failure.message || "Camera unavailable. Type a barcode or use a handheld scanner."); }
      }
    };
    run();
    return () => { active = false; stop(); if (video.current) video.current.srcObject = null; };
  }, [camera, disabled, cameraSupported, scopeKey]);
  return <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:p-4">
    <div className="flex items-center justify-between gap-2"><h3 className="font-medium">Scan a product</h3><button type="button" className="ht-button-secondary min-h-[44px]" onClick={onClose}>Close scanner</button></div>
    <p className="text-sm text-slate-600">Scan with a handheld scanner or enter the barcode. Scanning finds the article; enter its quantity in the displayed count unit.</p>
    <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); const value = barcode.trim(); if (value && !disabled) { setCamera(false); onScan(value); } }}>
      <label className="min-w-0 flex-1 text-sm font-medium">Product barcode<input autoFocus aria-label="Product barcode" autoComplete="off" inputMode="text" maxLength="100" value={barcode} disabled={disabled} onChange={(event) => setBarcode(event.target.value)} className="ht-field mt-1 min-h-[44px] w-full" placeholder="Scan or type a barcode" /></label>
      <button type="submit" className="ht-button-primary min-h-[44px] self-end" disabled={disabled || !barcode.trim()}>Find barcode</button>
    </form>
    {cameraSupported ? <button type="button" className="ht-button-secondary min-h-[44px]" disabled={disabled} onClick={() => { setError(""); setCameraHint(""); setCamera((value) => !value); }}>{camera ? "Stop camera" : "Use camera"}</button> : <p className="text-xs text-slate-500">Camera scanning is unavailable in this browser. Barcode entry and handheld scanners remain available.</p>}
    {camera && <video ref={video} muted playsInline aria-label="Barcode camera" className="aspect-video w-full rounded-lg bg-slate-900 object-cover" />}
    {camera && cameraHint && <p role="status" className="text-sm text-amber-800">{cameraHint}</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
  </div>;
}
