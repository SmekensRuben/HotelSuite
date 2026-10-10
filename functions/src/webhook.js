const { Webhook } = require("svix");
const { onRequest, logger, admin, RESEND_API_KEY, RESEND_WEBHOOK_SECRET } = require("./config");
const { extractEmailAddress, toEmailList, getFirstAvailableImportAttachment, fetchResendAttachmentBuffer } = require("./common");
const { hotelHasActiveSubscription } = require("./subscriptions");
const { stableId, resolveImportRoute, claimReceipt, finishReceipt, releaseReceipt } = require("./importRouting");

function verifyResendWebhook(req) {
  const secret = String(RESEND_WEBHOOK_SECRET.value() || "").trim();
  if (!secret) throw new Error("Missing RESEND_WEBHOOK_SECRET");
  if (!req.rawBody) throw new Error("Missing raw webhook body");
  return new Webhook(secret).verify(req.rawBody, {
    "svix-id": req.get("svix-id") || "",
    "svix-timestamp": req.get("svix-timestamp") || "",
    "svix-signature": req.get("svix-signature") || "",
  });
}

function createResendEmailReceivedHandler({ db, bucket, verify = verifyResendWebhook,
  fetchAttachment = fetchResendAttachmentBuffer, activeSubscription = hotelHasActiveSubscription, log = logger }) {
  return async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
    let payload;
    try { payload = verify(req); }
    catch (error) {
      log.warn("Rejected Resend webhook", { message: error?.message || String(error) });
      return res.status(401).json({ error: "Invalid webhook signature" });
    }
    let receiptRef, owner;
    try {
      if (payload?.type !== "email.received") return res.status(200).json({ ok: true, ignored: true });
      const emailData = payload?.data && typeof payload.data === "object" ? payload.data : {};
      const fromEmail = extractEmailAddress(emailData.from || emailData.sender || emailData.fromEmail);
      const toEmails = toEmailList(emailData.to);
      const subject = String(emailData.subject || "").trim().toLowerCase();
      const emailId = String(emailData.email_id || "").trim();
      if (!emailId || !fromEmail || !toEmails.length || !subject) {
        return res.status(400).json({ error: "Missing email_id/from/to/subject in payload" });
      }
      const attachment = getFirstAvailableImportAttachment(emailData);
      if (!attachment?.id) return res.status(400).json({ error: "No supported attachment with a provider id" });

      // A signed provider event authenticates bytes, while this operator-owned
      // identity establishes the tenant before any tenant-editable rules are read.
      const route = await resolveImportRoute(db, { fromEmail, toEmails, subject });
      if (!await activeSubscription(db, route.hotelUid)) return res.status(403).json({ error: "Receiving hotel is inactive" });
      const receiptId = stableId("resend", emailId, attachment.id);
      const storagePath = `imports/${route.hotelUid}/${route.fileType}/${receiptId}.${attachment.extension}`;
      const descriptor = { ...route, emailId, attachmentId: attachment.id, storagePath, contentType: attachment.contentType };
      receiptRef = db.doc(`importIngressReceipts/${receiptId}`);
      const claim = await claimReceipt(db, receiptRef, descriptor, { initialData: {
        firstWebhookEventId: String(req.get("svix-id") || ""), eventType: "email.received", firstReceivedAt: Date.now(),
      } });
      if (claim.state === "complete") return res.status(200).json({ ...claim.result, duplicate: true });
      if (claim.state === "busy") return res.status(503).json({ error: "Import delivery is already processing; retry later" });
      owner = claim.owner;
      const attachmentBuffer = await fetchAttachment(emailData, attachment.id);
      const file = bucket.file(storagePath);
      const descriptorHash = stableId(descriptor);
      try {
        await file.save(attachmentBuffer, {
          resumable: false, preconditionOpts: { ifGenerationMatch: 0 },
          contentType: attachment.contentType,
          metadata: { cacheControl: "private, no-store", metadata: {
            hotelUid: route.hotelUid, fileType: route.fileType, fromEmail, toEmail: route.receiver,
            subject, matchedSettingId: route.settingId, receiverId: route.receiverId,
            ingressReceiptId: receiptId, descriptorHash,
          } },
        });
      } catch (error) {
        if (Number(error.code) !== 412) throw error;
        const [existing] = await file.getMetadata();
        if (existing.metadata?.ingressReceiptId !== receiptId || existing.metadata?.descriptorHash !== descriptorHash
          || existing.metadata?.hotelUid !== route.hotelUid || existing.metadata?.fileType !== route.fileType) {
          throw new Error("Deterministic import object ownership conflict");
        }
      }
      const result = { ok: true, storagePath, hotelUid: route.hotelUid, fileType: route.fileType };
      await finishReceipt(db, receiptRef, owner, result);
      log.info("Resend webhook import stored", { ...route, storagePath });
      return res.status(200).json(result);
    } catch (error) {
      if (receiptRef && owner) await releaseReceipt(db, receiptRef, owner).catch(() => {});
      log.error("handleResendEmailReceivedWebhook failed", { message: error?.message || String(error) });
      return res.status(error.status || 500).json({ error: error.status ? error.message : "Internal Server Error" });
    }
  };
}
const handleResendEmailReceivedWebhook = onRequest({ secrets: [RESEND_API_KEY, RESEND_WEBHOOK_SECRET] }, (req, res) =>
  createResendEmailReceivedHandler({ db: admin.firestore(), bucket: admin.storage().bucket() })(req, res));

module.exports = { handleResendEmailReceivedWebhook, verifyResendWebhook, createResendEmailReceivedHandler };
