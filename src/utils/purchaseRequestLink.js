// Email links are local navigation hints; hotel membership and action authority
// are always checked after sign-in and selecting the intended hotel.
export function purchaseRequestReturnPath(value) {
  if (typeof value !== "string" || value.length > 2000 || /[\\\u0000-\u001f]/.test(value)) return null;
  return /^\/purchase-requests(?:\/[a-zA-Z0-9_-]{1,128})?(?:\/edit)?(?:[?#]|$)/.test(value) ? value : null;
}
