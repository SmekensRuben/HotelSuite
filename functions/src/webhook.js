const { onRequest, logger, admin, RESEND_API_KEY } = require("./config");
const { extractEmailAddress, toEmailList, getFirstAvailableImportAttachment, fetchResendAttachmentBuffer, normalizeFileType } = require("./common");

const handleResendEmailReceivedWebhook = onRequest({ secrets: [RESEND_API_KEY] }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  try {
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const emailData = payload?.data && typeof payload.data === "object" ? payload.data : payload;
    const fromEmail = extractEmailAddress(emailData.from || emailData.sender || emailData.fromEmail);
    const toCandidates = [
      ...toEmailList(emailData.to),
      ...toEmailList(emailData.deliveredTo),
      ...toEmailList(emailData.recipient),
    ];
    const toEmailSet = new Set(toCandidates);
    const subject = String(emailData.subject || "").trim().toLowerCase();

    if (!fromEmail || toEmailSet.size === 0 || !subject) {
      res.status(400).json({ error: "Missing from/to/subject in payload" });
      return;
    }

    const importAttachment = getFirstAvailableImportAttachment(emailData);
    if (!importAttachment) {
      res.status(400).json({ error: "No CSV, TXT, or XML attachment found" });
      return;
    }

    if (!importAttachment.id) {
      res.status(400).json({ error: "Attachment metadata missing id" });
      return;
    }

    const indexSnapshot = await admin.firestore().collection("fileImportSettingsIndex").get();
    const matchedSetting = indexSnapshot.docs
      .map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }))
      .find((setting) => {
        const settingFrom = extractEmailAddress(setting.fromEmail);
        const settingTo = extractEmailAddress(setting.toEmail);
        const subjectContains = String(setting.subjectContains || setting.subject || "").trim().toLowerCase();

        if (!settingFrom || !settingTo || !subjectContains) return false;
        return settingFrom === fromEmail && toEmailSet.has(settingTo) && subject.includes(subjectContains);
      });

    if (!matchedSetting) {
      res.status(404).json({ error: "No matching file import setting found" });
      return;
    }

    const hotelUid = String(matchedSetting.hotelUid || "").trim();
    if (!hotelUid) {
      res.status(422).json({ error: "Matched setting has no hotelUid" });
      return;
    }

    const fileType = normalizeFileType(matchedSetting.fileType);
    const timestamp = Date.now();
    const storagePath = `imports/${hotelUid}/${fileType}/${timestamp}.${importAttachment.extension}`;

    const bucket = admin.storage().bucket();
    const file = bucket.file(storagePath);

    const attachmentBuffer = await fetchResendAttachmentBuffer(emailData, importAttachment.id);

    await file.save(attachmentBuffer, {
      contentType: importAttachment.contentType,
      metadata: {
        metadata: {
          hotelUid,
          fileType,
          fromEmail,
          toEmail: Array.from(toEmailSet).join(","),
          subject,
          matchedSettingId: String(matchedSetting.id || ""),
        },
      },
    });

    logger.info("Resend webhook import stored", {
      hotelUid,
      fileType,
      storagePath,
      matchedSettingId: matchedSetting.id,
    });

    res.status(200).json({ ok: true, storagePath, hotelUid, fileType });
  } catch (error) {
    logger.error("handleResendEmailReceivedWebhook failed", { message: error?.message || String(error) });
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = { handleResendEmailReceivedWebhook };
