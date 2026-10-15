import React, { useEffect, useRef, useState } from "react";
import { auth } from "../../firebaseConfig";
import SupplierProductImage from "./SupplierProductImage";
import { validateSupplierImageFile } from "../../services/firebaseSupplierProductImages";
import { decideProductProposalImage, getPendingProductProposalImageAction, getProductProposalImage, prepareProductProposalImage, retryProductProposalImageAction, safeProductProposalImageUrl, uploadProductProposalImage } from "../../services/firebaseProductProposalImages";

const fieldClass = "mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";
const defaultAction = (action) => action();
const message = (value, fallback) => typeof value === "string" && value ? value.slice(0, 600) : fallback;

export default function ProductProposalImageReview({ hotelUid, batchId, batchRevision, row, canEdit = false, canReplaceExisting = canEdit, disabled = false, onImageAction = defaultAction }) {
  const image = row.image, actor = auth.currentUser;
  const [preview, setPreview] = useState(null), [previewError, setPreviewError] = useState(null), [previewAttempt, setPreviewAttempt] = useState(0);
  const [error, setError] = useState(null), [busy, setBusy] = useState(false), [pending, setPending] = useState(null), [sourceOpen, setSourceOpen] = useState(false);
  const [imageUrl, setImageUrl] = useState(""), [sourcePageUrl, setSourcePageUrl] = useState(""), [file, setFile] = useState(null), [replaceExisting, setReplaceExisting] = useState(false);
  const alive = useRef(true), operation = useRef(false), fileInput = useRef(null);
  const currentImage = image?.currentImage, existing = Boolean(currentImage?.assetId || currentImage?.status && currentImage.status !== "none" || currentImage?.imageRevision > 0);
  const productId = row.status === "applied" ? row.result?.productId || row.productId : row.action === "update" ? row.productId : null;
  const name = [row.proposed?.supplierProductName, row.patch?.supplierProductName, row.original?.supplierProductName].find((value) => typeof value === "string" && value.trim()) || "Supplier product";
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    try { setPending(getPendingProductProposalImageAction(hotelUid, batchId, row.rowId)); } catch (failure) { setError(failure); }
  }, [hotelUid, batchId, row.rowId, image?.assetId, image?.decisionRevision]);
  useEffect(() => { setReplaceExisting(false); }, [image?.assetId, currentImage?.imageRevision]);
  useEffect(() => {
    let active = true, objectUrl;
    setPreview(null); setPreviewError(null);
    if (actor?.uid && image?.status === "ready") Promise.resolve().then(() => getProductProposalImage(hotelUid, batchId, row.rowId, image, "display")).then((blob) => {
      if (!active || auth.currentUser !== actor) return;
      objectUrl = URL.createObjectURL(blob); setPreview({ actor, hotelUid, batchId, rowId: row.rowId, assetId: image.assetId, url: objectUrl });
    }).catch((failure) => { if (active && auth.currentUser === actor) setPreviewError(failure); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [actor, hotelUid, batchId, row.rowId, image?.assetId, image?.status, previewAttempt]);
  const run = async (action) => {
    if (operation.current || disabled || !canEdit || !actor?.uid) return;
    operation.current = true; setBusy(true); setError(null);
    try {
      await onImageAction(action);
      if (alive.current && auth.currentUser === actor) { setFile(null); if (fileInput.current) fileInput.current.value = ""; setPending(getPendingProductProposalImageAction(hotelUid, batchId, row.rowId)); }
    } catch (failure) {
      if (alive.current && auth.currentUser === actor) { setError(failure); setPending(getPendingProductProposalImageAction(hotelUid, batchId, row.rowId)); }
    } finally { if (alive.current && auth.currentUser === actor) { operation.current = false; setBusy(false); } }
  };
  const decide = (action) => run(() => decideProductProposalImage(hotelUid, batchId, row.rowId, { assetId: image.assetId, expectedBatchRevision: batchRevision, action,
    replaceExisting: action === "select" && existing && replaceExisting, ...(action === "select" && existing ? { expectedImageRevision: currentImage.imageRevision } : {}) }));
  const validPreview = preview?.actor === actor && preview.hotelUid === hotelUid && preview.batchId === batchId && preview.rowId === row.rowId && preview.assetId === image?.assetId;
  const locked = disabled || busy || !canEdit || Boolean(pending), attached = image?.attachment?.status === "attached";
  const imageConflict = image?.selection === "selected" && image?.attachment?.status === "failed" && image.attachment.error?.code === "image-conflict";
  const needsSelection = image?.selection !== "selected" || imageConflict;
  const chooseFile = (event) => {
    try { const chosen = event.target.files?.[0] || null; if (chosen) validateSupplierImageFile(chosen); setFile(chosen); setError(null); }
    catch (failure) { event.target.value = ""; setFile(null); setError(failure); }
  };
  return <section aria-label={`Image review for ${name}`} className="space-y-3 rounded-xl border border-stone-200 bg-stone-50 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Product image <span className="font-normal text-stone-500">· optional</span></h3>{image && <span className="text-xs text-stone-600">{attached ? "Attached" : image.selection === "selected" ? "Selected for approval" : image.selection === "omitted" ? "Omitted" : "Not selected"}</span>}</div>
    <p className="text-xs text-stone-600">Images need your own review. Product details can be approved without an image, including when image preparation fails.</p>
    {image && <div className="flex flex-wrap gap-4">
      {existing && productId && <div><p className="mb-1 text-xs font-medium">Current product image</p><SupplierProductImage hotelUid={hotelUid} product={{ id: productId, supplierProductName: name, imageRevision: currentImage.imageRevision, image: { assetId: currentImage.assetId, status: currentImage.status } }} variant="display" className="h-28 w-32" /></div>}
      <div className="space-y-1"><p className="text-xs font-medium">Proposed image</p>{validPreview && !previewError ? <img src={preview.url} alt={`Proposed image for ${name}`} className="h-28 max-w-full rounded-lg border bg-white object-contain" referrerPolicy="no-referrer" onError={() => setPreviewError(new Error("The private preview could not be displayed."))} /> : <div className="flex h-28 w-32 items-center justify-center rounded-lg border bg-white p-3 text-center text-xs text-stone-500">{image.status === "preparing" ? "Preparing private image…" : image.status === "ready" && !previewError ? "Loading private preview…" : "Preview unavailable"}</div>}{image.width && image.height && <p className="text-xs text-stone-500">{image.width} × {image.height}</p>}</div>
    </div>}
    {previewError && <p role="alert" className="text-xs text-amber-950">The private image preview is unavailable.<button type="button" className="ml-2 underline" disabled={busy} onClick={() => setPreviewAttempt((value) => value + 1)}>Retry preview</button></p>}
    {image?.error && <p role="alert" className="text-xs text-amber-950">{message(image.error.message, "Image preparation failed. Retry or choose another image.")}</p>}
    {image?.attachment?.status === "failed" && <p role="alert" className="text-xs text-amber-950">Product details were saved, but the image was not attached. {message(image.attachment.error?.message, "Review the image and retry attachment.")}</p>}
    {image?.attachment?.status === "attaching" && <p className="text-xs text-stone-600">The image attachment is still in progress. Retry to check or resume it.</p>}
    {image?.status === "expired" && <p className="text-xs text-amber-950">The temporary image expired. Retry preparation or choose a replacement, then review the new preview. Product approval remains available.</p>}
    {error && <p role="alert" className="text-xs text-red-700">{message(error.message, "This image action failed. Retry or omit the image.")}</p>}
    {pending && <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-950"><p>The previous image action needs confirmation. Recover it before choosing another image.</p><button type="button" disabled={disabled || busy || !canEdit} className="ht-button-secondary mt-2" onClick={() => run(() => retryProductProposalImageAction(hotelUid, batchId, row.rowId))}>Retry original image action</button></div>}
    {image?.sourceUrl && safeProductProposalImageUrl(image.sourceUrl) && <p className="text-xs"><a href={safeProductProposalImageUrl(image.sourceUrl)} target="_blank" rel="noreferrer" className="text-stone-600 underline">Image source</a>{image.sourcePageUrl && safeProductProposalImageUrl(image.sourcePageUrl) && <> · <a href={safeProductProposalImageUrl(image.sourcePageUrl)} target="_blank" rel="noreferrer" className="text-stone-600 underline">Source page</a></>}</p>}
    {image?.status === "ready" && !attached && <div className="space-y-3">
      {existing && needsSelection && <label className="flex items-start gap-2 text-xs text-amber-950"><input type="checkbox" checked={replaceExisting} disabled={locked || !canReplaceExisting} onChange={(event) => setReplaceExisting(event.target.checked)} />Replace the current product image with this reviewed image.</label>}
      {existing && !canReplaceExisting && <p className="text-xs text-stone-500">Replacing an existing image also requires supplier-product update permission.</p>}
      <div className="flex flex-wrap gap-2">{needsSelection && <button type="button" className="ht-button-primary" disabled={locked || Boolean(previewError) || !validPreview || existing && (!replaceExisting || !canReplaceExisting)} onClick={() => decide("select")}>{imageConflict ? "Confirm replacement again" : "Use this image"}</button>}{image.selection === "selected" && !imageConflict && row.status === "applied" && <button type="button" className="ht-button-primary" disabled={locked || existing && !canReplaceExisting} onClick={() => decide("attach")}>{["failed", "attaching"].includes(image.attachment?.status) ? "Retry image attachment" : "Attach image"}</button>}<button type="button" className="ht-button-secondary" disabled={locked} onClick={() => decide("omit")}>Omit image</button></div>
      {image.selection === "selected" && row.status !== "applied" && <p className="text-xs text-stone-600">This image will be attached only after you approve this product. Current image revisions are checked again before attachment.</p>}
    </div>}
    {image && image.status !== "ready" && !attached && <div className="flex flex-wrap gap-2">{["preparing", "failed", "expired"].includes(image.status) && safeProductProposalImageUrl(image.sourceUrl) && <button type="button" className="ht-button-secondary" disabled={locked} onClick={() => decide("retry")}>Retry image preparation</button>}<button type="button" className="ht-button-secondary" disabled={locked} onClick={() => decide("omit")}>Omit image</button></div>}
    <button type="button" className="text-xs text-stone-600 underline" disabled={locked} onClick={() => setSourceOpen(!sourceOpen)}>{sourceOpen ? "Close image source" : image ? "Choose another image" : "Add an image"}</button>
    {sourceOpen && <div className="space-y-3 border-t border-stone-200 pt-3">
      <form onSubmit={(event) => { event.preventDefault(); run(() => prepareProductProposalImage(hotelUid, batchId, row.rowId, { imageUrl, sourcePageUrl })); }} className="space-y-3"><label className="block text-xs font-semibold">Direct image URL<input aria-label="Direct image URL" type="url" required value={imageUrl} disabled={locked} className={fieldClass} onChange={(event) => setImageUrl(event.target.value)} placeholder="https://supplier.example/product.webp" /></label><label className="block text-xs font-semibold">Source page (optional)<input aria-label="Image source page" type="url" value={sourcePageUrl} disabled={locked} className={fieldClass} onChange={(event) => setSourcePageUrl(event.target.value)} placeholder="https://supplier.example/product" /></label><button type="submit" className="ht-button-secondary" disabled={locked || !imageUrl.trim()}>Prepare image URL</button></form>
      <div className="space-y-2"><label className="block text-xs font-semibold">Upload a replacement image<input ref={fileInput} aria-label="Upload proposed product image" type="file" accept="image/jpeg,image/png,image/webp" disabled={locked} onChange={chooseFile} className="mt-2 block w-full max-w-full text-xs" /></label><p className="text-xs text-stone-500">JPEG, PNG or WebP, up to 5 MiB. Preparation creates a private optimized preview; uploading does not select or attach the image.</p><button type="button" className="ht-button-secondary" disabled={locked || !file} onClick={() => run(() => uploadProductProposalImage(hotelUid, batchId, row.rowId, file))}>Prepare uploaded image</button></div>
    </div>}
    {!canEdit && <p className="text-xs text-stone-500">The relevant supplier-product action permission is required to choose or attach this image.</p>}
  </section>;
}
