import React, { useEffect, useRef, useState } from "react";
import { validateSupplierImageFile } from "../../services/firebaseSupplierProductImages";

export default function SupplierProductImagePicker({ file, onChange, disabled = false, label = "Upload product image", onError }) {
  const input = useRef(null);
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    if (!file) { setPreview(null); if (input.current) input.current.value = ""; return; }
    const url = URL.createObjectURL(file); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const select = (event) => {
    try {
      const chosen = event.target.files?.[0] || null;
      if (chosen) validateSupplierImageFile(chosen);
      onError?.(null); onChange(chosen);
    } catch (error) { event.target.value = ""; onChange(null); onError?.(error); }
  };
  return <div className="space-y-3">
    <label className="block text-sm font-semibold">{label}<input ref={input} type="file" accept="image/jpeg,image/png,image/webp" disabled={disabled} onChange={select} className="mt-2 block w-full max-w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-stone-100 file:px-3 file:py-2 file:text-sm file:font-medium" /></label>
    <p className="text-xs text-stone-500">JPEG, PNG or WebP, up to 5 MiB and 16 megapixels. Images stay inside this hotel's protected storage. Small WebP previews are generated automatically; animated images are not supported.</p>
    {file && <div className="flex flex-wrap items-center gap-3">
      {preview && <img src={preview} alt="Selected upload preview" className="h-28 max-w-full rounded-xl border object-contain" />}
      <span className="break-all text-sm text-stone-600">{file.name}</span>
      <button type="button" disabled={disabled} onClick={() => { onChange(null); onError?.(null); }} className="ht-button-secondary">Remove selected image</button>
    </div>}
  </div>;
}
