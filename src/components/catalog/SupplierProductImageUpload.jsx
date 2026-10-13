import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { auth } from "../../firebaseConfig";
import { uploadSupplierProductImage, validateSupplierImageFile } from "../../services/firebaseSupplierProductImages";
import { useHotelContext } from "../../contexts/HotelContext";
import { usePermission } from "../../hooks/usePermission";
import AsyncError from "../shared/AsyncError";

const uncertainError = (error) => !["invalid-argument", "permission-denied", "unauthenticated", "not-found", "already-exists", "aborted", "failed-precondition"].includes(String(error.code || "").replace(/^functions\//, ""));
export default function SupplierProductImageUpload({ hotelUid, product, onChanged }) {
  const actor = auth.currentUser;
  const { permissions, subscriptionActive, subscription } = useHotelContext();
  const canManage = usePermission("supplierproducts", "update");
  const authority = JSON.stringify([hotelUid, product?.id, permissions, subscriptionActive, subscription]);
  return <ImageUploader key={authority} hotelUid={hotelUid} product={product} onChanged={onChanged} actor={actor} canManage={canManage} />;
}
function ImageUploader({ hotelUid, product, onChanged, actor, canManage }) {
  const mounted = useRef(false), input = useRef(null), commandProduct = useRef(null);
  const [file, setFile] = useState(null), [preview, setPreview] = useState(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(null), [message, setMessage] = useState(null), [uncertain, setUncertain] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { setFile(null); setError(null); setMessage(null); setBusy(false); setUncertain(false); commandProduct.current = null; if (input.current) input.current.value = ""; }, [actor]);
  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const select = (event) => {
    setError(null); setMessage(null); setUncertain(false); commandProduct.current = null;
    try { const chosen = event.target.files?.[0]; if (chosen) validateSupplierImageFile(chosen); setFile(chosen || null); }
    catch (failure) { setFile(null); setError(failure); event.target.value = ""; }
  };
  const upload = async (event) => {
    event.preventDefault(); if (!canManage || !file || busy || auth.currentUser !== actor) return;
    const current = () => mounted.current && auth.currentUser === actor;
    commandProduct.current ||= product;
    setBusy(true); setError(null); setMessage(null);
    let confirmed = false;
    try {
      const result = await uploadSupplierProductImage(hotelUid, commandProduct.current, file);
      if (!current()) return;
      confirmed = true; commandProduct.current = null;
      setUncertain(false); setFile(null); if (input.current) input.current.value = "";
      setMessage({ failed: result.status === "failed", text: result.status === "ready" ? "Product image saved with its thumbnail." : result.status === "pending" ? "Image uploaded. Thumbnail preparation is pending; refresh this product to check it." : "Image uploaded, but thumbnail preparation failed. Select a replacement or reload the product for its status." });
    } catch (failure) {
      if (current()) { setError(failure); const unknown = uncertainError(failure); setUncertain(unknown); if (!unknown) commandProduct.current = null; }
    } finally { if (current()) setBusy(false); }
    if (confirmed && current()) {
      try { await onChanged?.(); }
      catch (failure) { if (current()) { setError(Object.assign(new Error(`The upload was confirmed, but reloading the product failed. ${failure.message || "Reload the product to check its status."}`), { imageUploadConfirmed: true })); setUncertain(false); } }
    }
  };
  if (!canManage) return null;
  return <form onSubmit={upload} className="mt-4 space-y-3 border-t border-stone-200 pt-4">
    <label className="block text-sm font-semibold">{product?.image?.assetId ? "Replace product image" : "Upload product image"}<input ref={input} type="file" accept="image/jpeg,image/png,image/webp" disabled={busy || uncertain} onChange={select} className="mt-2 block w-full max-w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-stone-100 file:px-3 file:py-2 file:text-sm file:font-medium" /></label>
    <p className="text-xs text-stone-500">JPEG, PNG or WebP, up to 5 MiB and 16 megapixels. Images stay inside this hotel's protected storage. Small WebP previews are generated automatically; animated images are not supported.</p>
    {preview && <img src={preview} alt="Selected upload preview" className="h-28 max-w-full rounded-xl border object-contain" />}
    <AsyncError error={error} label={error?.imageUploadConfirmed ? "Image upload confirmed; product reload failed." : "Could not verify the product image upload."} />
    {uncertain && <p className="text-sm text-amber-900">The response was not verified. Retry the same file safely, or reload the product to check whether it was saved.</p>}
    {product?.image?.status === "failed" && <p role="status" className="text-sm text-amber-900">Thumbnail preparation failed. The product remains usable; choose a replacement image.</p>}
    {message && <p role="status" className={`text-sm ${message.failed ? "text-amber-900" : "text-emerald-900"}`}>{message.text}</p>}
    <div className="flex flex-wrap gap-2"><button type="submit" disabled={busy || !file} className="ht-button-primary">{busy ? "Uploading and preparing image…" : uncertain ? "Retry same image" : "Save product image"}</button>{(error || product?.image?.status === "pending") && <button type="button" disabled={busy} className="ht-button-secondary" onClick={() => onChanged?.()}>Reload product</button>}</div>
  </form>;
}
