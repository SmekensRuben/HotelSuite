import React, { useEffect, useRef, useState } from "react";
import { Image as ImageIcon } from "lucide-react";
import { auth } from "../../firebaseConfig";
import { getSupplierProductImage } from "../../services/firebaseSupplierProductImages";
import { useHotelContext } from "../../contexts/HotelContext";
import { usePermission } from "../../hooks/usePermission";

function externalImage(value) {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
export default function SupplierProductImage({ hotelUid, product, variant = "thumbnail", className = "h-12 w-12" }) {
  const actor = auth.currentUser;
  const { permissions, subscription, subscriptionActive } = useHotelContext();
  const canRead = usePermission("supplierproducts", "read");
  const authority = JSON.stringify([hotelUid, permissions, subscription, subscriptionActive]);
  const assetId = product?.image?.assetId, status = product?.image?.status;
  const [state, setState] = useState({ actor: null, authority: null, assetId: null, variant: null, url: null });
  const [externalFailed, setExternalFailed] = useState(null);
  const element = useRef(null);
  const [visible, setVisible] = useState(() => variant !== "thumbnail" || typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (variant !== "thumbnail" || typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "160px" });
    if (element.current) observer.observe(element.current);
    return () => observer.disconnect();
  }, [variant]);
  useEffect(() => {
    let current = true, url;
    if (canRead && visible && status === "ready" && assetId) {
      getSupplierProductImage(hotelUid, product, variant).then((blob) => {
        if (!current || auth.currentUser !== actor) return;
        url = URL.createObjectURL(blob);
        setState({ actor, authority, assetId, variant, url });
      }).catch(() => { if (current) setState({ actor, authority, assetId, variant, url: null }); });
    }
    return () => { current = false; if (url) URL.revokeObjectURL(url); };
  }, [hotelUid, product?.id, assetId, status, variant, actor, authority, canRead, visible]);
  const managed = Boolean(assetId);
  const verified = state.actor === actor && state.authority === authority && state.assetId === assetId && state.variant === variant;
  const url = managed ? status === "ready" && verified ? state.url : null
    : canRead ? externalImage(product?.imageUrl) : null;
  const loading = canRead && managed && (status === "pending" || status === "ready" && !verified);
  const name = product?.supplierProductName || "Supplier product";
  return <span ref={element} className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl border border-stone-200 bg-stone-50 ${className}`} aria-busy={loading || undefined}>
    {url && externalFailed !== url ? <img src={url} alt={name} loading="lazy" decoding="async" referrerPolicy="no-referrer" className="h-full w-full object-contain" onError={() => setExternalFailed(url)} />
      : <span role="img" aria-label={loading ? `Preparing image for ${name}` : `No available image for ${name}`} className={`flex h-full w-full items-center justify-center text-stone-400 ${loading ? "motion-safe:animate-pulse" : ""}`}><ImageIcon size={20} aria-hidden="true" /></span>}
  </span>;
}
