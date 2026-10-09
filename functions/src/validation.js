const { HttpsError } = require("firebase-functions/v2/https");
const { createHash } = require("node:crypto");

function requireVerifiedUser(request) {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Sign in to continue.");
  if (request.auth.token?.email_verified !== true) {
    throw new HttpsError("permission-denied", "Verify your email address before continuing.");
  }
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

module.exports = { requireVerifiedUser, text, email, revision, digest };
