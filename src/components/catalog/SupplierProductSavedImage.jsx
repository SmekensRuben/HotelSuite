import React, { useState } from "react";
import SupplierProductImageUpload from "./SupplierProductImageUpload";

// Product creation/update and media processing have separate confirmed outcomes.
export default function SupplierProductSavedImage({ hotelUid, product, file, onOpen }) {
  const [current, setCurrent] = useState(product);
  const changed = (result) => {
    if (!result || result.status === "ready") { onOpen(); return; }
    setCurrent((saved) => ({ ...saved, imageRevision: result.imageRevision, image: { assetId: result.assetId, status: result.status } }));
  };
  return <div className="space-y-3">
    <p role="status" className="font-semibold text-emerald-900">Supplier product saved.</p>
    <p className="text-sm text-stone-600">The product is already saved. Image preparation is handled separately; retrying the image will not create another product.</p>
    <SupplierProductImageUpload hotelUid={hotelUid} product={current} initialFile={file} autoUpload onChanged={changed} />
    <button type="button" onClick={onOpen} className="ht-button-secondary">Open saved product</button>
  </div>;
}
