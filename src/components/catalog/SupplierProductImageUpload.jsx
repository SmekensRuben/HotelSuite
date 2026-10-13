import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { auth } from "../../firebaseConfig";
import { uploadSupplierProductImage } from "../../services/firebaseSupplierProductImages";
import { useHotelContext } from "../../contexts/HotelContext";
import { usePermission } from "../../hooks/usePermission";
import AsyncError from "../shared/AsyncError";
import SupplierProductImagePicker from "./SupplierProductImagePicker";

const uncertainError = (error) => !["invalid-argument", "permission-denied", "unauthenticated", "not-found", "already-exists", "aborted", "failed-precondition"].includes(String(error.code || "").replace(/^functions\//, ""));
export default function SupplierProductImageUpload({ hotelUid, product, onChanged, initialFile = null, autoUpload = false }) {
  const actor = auth.currentUser;
  const { permissions, subscriptionActive, subscription } = useHotelContext();
  const canManage = usePermission("supplierproducts", "update");
  const authority = JSON.stringify([hotelUid, product?.id, permissions, subscriptionActive, subscription]);
  return <ImageUploader key={authority} hotelUid={hotelUid} product={product} onChanged={onChanged} actor={actor} canManage={canManage} initialFile={initialFile} autoUpload={autoUpload} />;
}
function ImageUploader({ hotelUid, product, onChanged, actor, canManage, initialFile, autoUpload }) {
  const mounted = useRef(false), commandProduct = useRef(null), started = useRef(false), requestLock = useRef(false);
  const original = useRef({ actor, file: initialFile }).current;
  const [file, setFile] = useState(initialFile), [busy, setBusy] = useState(false);
  const [error, setError] = useState(null), [message, setMessage] = useState(null), [uncertain, setUncertain] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { setFile(actor === original.actor ? original.file : null); setError(null); setMessage(null); setBusy(false); setUncertain(false); commandProduct.current = null; }, [actor, original]);
  const select = (chosen) => {
    setError(null); setMessage(null); setUncertain(false); commandProduct.current = null;
    setFile(chosen);
  };
  const upload = async (event) => {
    event?.preventDefault(); if (!canManage || !file || requestLock.current || auth.currentUser !== actor) return;
    const current = () => mounted.current && auth.currentUser === actor;
    requestLock.current = true;
    commandProduct.current ||= product;
    setBusy(true); setError(null); setMessage(null);
    let confirmed = false, result;
    try {
      result = await uploadSupplierProductImage(hotelUid, commandProduct.current, file);
      if (!current()) return;
      confirmed = true; commandProduct.current = null;
      setUncertain(false); setFile(null);
      setMessage({ failed: result.status === "failed", text: result.status === "ready" ? "Product image saved with its thumbnail." : result.status === "pending" ? "Image uploaded. Thumbnail preparation is pending; refresh this product to check it." : "Image uploaded, but thumbnail preparation failed. Select a replacement or reload the product for its status." });
    } catch (failure) {
      if (current()) { setError(failure); const unknown = uncertainError(failure); setUncertain(unknown); if (!unknown) commandProduct.current = null; }
    } finally { requestLock.current = false; if (current()) setBusy(false); }
    if (confirmed && current()) {
      try { await onChanged?.(result); }
      catch (failure) { if (current()) { setError(Object.assign(new Error(`The upload was confirmed, but reloading the product failed. ${failure.message || "Reload the product to check its status."}`), { imageUploadConfirmed: true })); setUncertain(false); } }
    }
  };
  const uploadRef = useRef(upload); uploadRef.current = upload;
  useEffect(() => {
    if (autoUpload && file && canManage && actor === original.actor && !started.current) {
      started.current = true; uploadRef.current();
    }
  }, [autoUpload, file, canManage, actor, original]);
  if (!canManage) return null;
  return <form onSubmit={upload} className="mt-4 space-y-3 border-t border-stone-200 pt-4">
    <SupplierProductImagePicker file={file} onChange={select} onError={setError} disabled={busy || uncertain} label={product?.image?.assetId ? "Replace product image" : "Upload product image"} />
    <AsyncError error={error} label={error?.imageUploadConfirmed ? "Image upload confirmed; product reload failed." : "Could not verify the product image upload."} />
    {uncertain && <p className="text-sm text-amber-900">The response was not verified. Retry the same file safely, or reload the product to check whether it was saved.</p>}
    {product?.image?.status === "failed" && <p role="status" className="text-sm text-amber-900">Thumbnail preparation failed. The product remains usable; choose a replacement image.</p>}
    {message && <p role="status" className={`text-sm ${message.failed ? "text-amber-900" : "text-emerald-900"}`}>{message.text}</p>}
    <div className="flex flex-wrap gap-2"><button type="submit" disabled={busy || !file} className="ht-button-primary">{busy ? "Uploading and preparing image…" : uncertain ? "Retry same image" : "Save product image"}</button>{(error || product?.image?.status === "pending") && <button type="button" disabled={busy} className="ht-button-secondary" onClick={() => onChanged?.()}>Reload product</button>}</div>
  </form>;
}
