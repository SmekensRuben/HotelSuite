export function subscriptionIsActive(subscription, now = Date.now()) {
  if (!subscription || !["active", "trialing"].includes(subscription.status)) return false;
  if (subscription.validUntil == null) return subscription.status === "active";
  const expiry = subscription.validUntil?.toMillis?.();
  return Number.isFinite(expiry) && expiry > now;
}
