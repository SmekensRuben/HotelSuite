const { HttpsError } = require("firebase-functions/v2/https");
const { createHash } = require("node:crypto");
const CURRENT_ACTOR = Symbol("verified-current-auth-actor");

function requireVerifiedUser(request) {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Sign in to continue.");
  if (request.auth.token?.email_verified !== true) {
    throw new HttpsError("permission-denied", "Verify your email address before continuing.");
  }
}

// Request-scoped only: a callable JSON payload cannot supply this Symbol.
async function requireCurrentVerifiedUser(request, auth) {
  requireVerifiedUser(request);
  if (request[CURRENT_ACTOR]) return request[CURRENT_ACTOR];
  const identity = auth || require("./config").admin.auth();
  let user;
  try { user = await identity.getUser(request.auth.uid); }
  catch { throw new HttpsError("permission-denied", "This account is no longer available."); }
  if (!user || (user.uid !== undefined && user.uid !== request.auth.uid)) {
    throw new HttpsError("permission-denied", "This account is no longer available.");
  }
  const revokedAt = Date.parse(user.tokensValidAfterTime || "");
  const authenticatedAt = Number(request.auth.token?.auth_time) * 1000;
  if (user.disabled || user.emailVerified !== true
    || (request.auth.token?.platformAdmin === true && user.customClaims?.platformAdmin !== true)
    || (Number.isFinite(revokedAt) && Number.isFinite(authenticatedAt) && authenticatedAt < revokedAt)) {
    throw new HttpsError("permission-denied", "Your current account no longer permits this action.");
  }
  Object.defineProperty(request, CURRENT_ACTOR, { value: user });
  return user;
}

function text(value, field, max = 200, required = false) {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new HttpsError("invalid-argument", `${field} must be text of at most ${max} characters.`);
  }
  const result = value.trim();
  if (required && !result) throw new HttpsError("invalid-argument", `${field} is required.`);
  return result;
}

function email(value) {
  const result = text(value, "email", 254, true).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw new HttpsError("invalid-argument", "A valid email address is required.");
  return result;
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new HttpsError("invalid-argument", "A valid expectedRevision is required.");
  return value;
}

function digest(...values) {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

module.exports = { requireVerifiedUser, requireCurrentVerifiedUser, text, email, revision, digest };
