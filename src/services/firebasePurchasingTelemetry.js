import { auth, functions, httpsCallable } from "../firebaseConfig";

const processes = new Set(["purchase-requests", "orders", "stock-counts", "contracts", "supplier-imports", "catalog-sync"]);
const unexpectedCodes = new Set(["internal", "unavailable", "deadline-exceeded", "unknown", "render-failed"]);
const attempts = new WeakMap();

export function purchasingErrorCode(error) {
  const code = typeof error?.code === "string" ? error.code.replace(/^functions\//, "") : "unknown";
  return unexpectedCodes.has(code) ? code : null;
}

// Only a fixed workflow classification leaves the browser. Record IDs, routes,
// messages, stacks, input values and user profile fields are never transmitted.
export function reportPurchasingError(hotelUid, process, error, options = {}) {
  try {
    const actor = auth.currentUser;
    const code = options.render === true ? "render-failed" : purchasingErrorCode(error);
    if (!["staging", "production"].includes(import.meta.env.VITE_DEPLOYMENT_ENV)) return;
    if (!actor?.uid || typeof hotelUid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(hotelUid) || !processes.has(process) || !code) return;
    if (!attempts.has(actor)) attempts.set(actor, new Map());
    const recent = attempts.get(actor), key = `${hotelUid}:${process}:${code}`, now = Date.now();
    if (recent.has(key) && now - recent.get(key) < 60000) return;
    if (recent.size >= 200) recent.delete(recent.keys().next().value);
    recent.set(key, now);
    // Detached reporting cannot fail, roll back or retry the original operation.
    Promise.resolve(httpsCallable(functions, "reportHotelPurchasingError")({ hotelUid, process, code })).catch(() => {});
  } catch { /* Telemetry is never a business-action dependency. */ }
}

export function purchasingProcessForPath(path) {
  if (typeof path !== "string") return null;
  if (/^\/purchase-(requests|budgets)(\/|$)/.test(path)) return "purchase-requests";
  if (/^\/orders(\/|$)/.test(path)) return "orders";
  if (/^\/catalog\/(stock-counts|inventory|inventory-movements)(\/|$)/.test(path)) return "stock-counts";
  if (/^\/contracts(\/|$)/.test(path)) return "contracts";
  if (/^\/catalog\/supplier-products\/imports(\/|$)/.test(path)) return "supplier-imports";
  if (/^\/catalog\/products\/sync(\/|$)/.test(path)) return "catalog-sync";
  return null;
}
