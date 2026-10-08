process.env.RESEND_WEBHOOK_SECRET = `whsec_${Buffer.from("permission-audit-webhook-secret").toString("base64")}`;

const test = require("node:test");
const assert = require("node:assert/strict");
const { Webhook } = require("svix");
const { verifyResendWebhook } = require("./webhook");

function signedRequest(payload) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const id = "msg_permission_audit";
  const timestamp = new Date();
  const signature = new Webhook(process.env.RESEND_WEBHOOK_SECRET).sign(id, timestamp, rawBody.toString());
  const headers = {
    "svix-id": id,
    "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "svix-signature": signature,
  };
  return { rawBody, get: (name) => headers[name.toLowerCase()] || "" };
}

test("verifyResendWebhook accepts an authentic raw payload", () => {
  const payload = { type: "email.received", data: { email_id: "email-1" } };
  assert.deepEqual(verifyResendWebhook(signedRequest(payload)), payload);
});

test("verifyResendWebhook rejects a modified payload", () => {
  const request = signedRequest({ type: "email.received", data: { email_id: "email-1" } });
  request.rawBody = Buffer.from(JSON.stringify({ type: "email.received", data: { email_id: "tampered" } }));
  assert.throws(() => verifyResendWebhook(request));
});
