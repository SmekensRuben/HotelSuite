const { onSchedule, logger, admin, Resend, RESEND_API_KEY, RESEND_FROM } = require("./config");

const db = admin.firestore();
const SCHEDULED_MAIL_DOC_PATH = "scheduledMails/guestIntelligence";
const DEFAULT_TIMEZONE = "Europe/Brussels";
const CONFIDENCE_RANK = { high: 0, medium: 1, low: 2 };

function sanitizeArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
}

function confidenceRank(value) {
  return CONFIDENCE_RANK[String(value || "").trim().toLowerCase()] ?? 3;
}

function sortGuestsByConfidence(guests) {
  return [...guests].sort((left, right) => {
    const identityDifference = confidenceRank(left.identityConfidence) - confidenceRank(right.identityConfidence);
    if (identityDifference) return identityDifference;
    const vipDifference = confidenceRank(left.vipConfidence) - confidenceRank(right.vipConfidence);
    if (vipDifference) return vipDifference;
    return String(left.fullName || "").localeCompare(String(right.fullName || ""), "nl", { sensitivity: "base" });
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function optionalText(value, fallback = "—") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function confidenceLabel(value) {
  const normalized = String(value || "").toLowerCase();
  return ({ high: "High", medium: "Medium", low: "Low" })[normalized] || "Unknown";
}

function safeSourceUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch (_error) {
    return null;
  }
}

function buildGuestHtml(guest) {
  const facts = Array.isArray(guest.notableFacts) ? guest.notableFacts.filter(Boolean) : [];
  const sources = Array.isArray(guest.sources) ? guest.sources : [];
  const sourceLinks = sources.flatMap((source) => {
    const url = safeSourceUrl(source?.url);
    if (!url) return [];
    return [`<a href="${escapeHtml(url)}" style="color:#9f1d20">${escapeHtml(optionalText(source?.title, "Source"))}</a>`];
  });
  const vipLabel = guest.isVip === true ? "Yes" : guest.isVip === false ? "No" : "Unknown";

  return `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:12px 0">
    <h3 style="margin:0 0 8px;color:#111827">${escapeHtml(optionalText(guest.fullName, "Unknown guest"))}</h3>
    <p style="margin:4px 0"><strong>Stay:</strong> ${escapeHtml(optionalText(guest.arrivalDate))} – ${escapeHtml(optionalText(guest.departureDate))} (${escapeHtml(optionalText(guest.nights))} nights)</p>
    <p style="margin:4px 0"><strong>Position:</strong> ${escapeHtml(optionalText(guest.jobTitle))} at ${escapeHtml(optionalText(guest.employer))}</p>
    <p style="margin:4px 0"><strong>Identity confidence:</strong> ${confidenceLabel(guest.identityConfidence)} · <strong>VIP:</strong> ${vipLabel} (${confidenceLabel(guest.vipConfidence)})</p>
    <p style="margin:8px 0">${escapeHtml(optionalText(guest.professionalProfile, "No professional profile found."))}</p>
    ${guest.vipReason ? `<p style="margin:4px 0"><strong>VIP rationale:</strong> ${escapeHtml(guest.vipReason)}</p>` : ""}
    ${guest.identityNotes ? `<p style="margin:4px 0"><strong>Identity notes:</strong> ${escapeHtml(guest.identityNotes)}</p>` : ""}
    ${facts.length ? `<p style="margin:8px 0 4px"><strong>Notable facts</strong></p><ul>${facts.map((fact) => `<li>${escapeHtml(fact)}</li>`).join("")}</ul>` : ""}
    ${sourceLinks.length ? `<p style="margin:8px 0 0"><strong>Sources:</strong> ${sourceLinks.join(" · ")}</p>` : ""}
  </div>`;
}

function buildEmailHtml(reports) {
  const hotelSections = reports.map((report) => `<section style="margin:28px 0">
    <h2 style="border-bottom:2px solid #9f1d20;padding-bottom:8px;color:#9f1d20">${escapeHtml(report.hotelName)}</h2>
    <p><strong>Report date:</strong> ${escapeHtml(optionalText(report.reportDate, "No report available"))}</p>
    ${report.guests.length ? report.guests.map(buildGuestHtml).join("") : "<p>No recent guest intelligence is available for this hotel.</p>"}
  </section>`).join("");

  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#374151;line-height:1.5;max-width:900px;margin:auto;padding:24px">
    <h1 style="color:#111827">Guest Intelligence Overview</h1>
    <p>Guests are grouped by hotel and ranked from high to low identity confidence.</p>
    ${hotelSections}
  </body></html>`;
}

function buildEmailText(reports) {
  return reports.map((report) => {
    const heading = `${report.hotelName} — ${report.reportDate || "no report available"}`;
    if (!report.guests.length) return `${heading}\nNo recent guest intelligence is available.`;
    const guests = report.guests.map((guest) => [
      `${guest.fullName || "Unknown guest"} | identity: ${confidenceLabel(guest.identityConfidence)} | VIP: ${guest.isVip === true ? "yes" : guest.isVip === false ? "no" : "unknown"}`,
      `${optionalText(guest.jobTitle)} at ${optionalText(guest.employer)}`,
      optionalText(guest.professionalProfile, "No professional profile found."),
    ].join("\n"));
    return `${heading}\n${guests.join("\n\n")}`;
  }).join("\n\n---\n\n");
}

async function getLatestGuestIntelligence(hotelUid, firestore = db) {
  const hotelRef = firestore.doc(`hotels/${hotelUid}`);
  const [hotelSnapshot, dateCollections] = await Promise.all([
    hotelRef.get(),
    hotelRef.collection("guestIntelligence").listDocuments(),
  ]);
  const hotelName = optionalText(hotelSnapshot.data()?.hotelName, hotelUid);
  const latestDateRef = dateCollections
    .filter((reference) => /^\d{4}-\d{2}-\d{2}$/.test(reference.id))
    .sort((left, right) => right.id.localeCompare(left.id))[0];
  if (!latestDateRef) return { hotelUid, hotelName, reportDate: null, guests: [] };

  const guestSnapshot = await latestDateRef.collection("guests").get();
  const guests = guestSnapshot.docs.map((document) => ({ reservationId: document.id, ...document.data() }));
  return { hotelUid, hotelName, reportDate: latestDateRef.id, guests: sortGuestsByConfidence(guests) };
}

async function sendGuestIntelligenceMail({ firestore = db, ResendClass = Resend } = {}) {
  const configurationSnapshot = await firestore.doc(SCHEDULED_MAIL_DOC_PATH).get();
  if (!configurationSnapshot.exists) {
    logger.warn("Guest intelligence mail configuration not found; skipping send");
    return null;
  }

  const configuration = configurationSnapshot.data() || {};
  const hotelUids = sanitizeArray(configuration.hotelUid);
  const recipients = sanitizeArray(configuration.sendList);
  if (!hotelUids.length) throw new Error("No hotelUid configuration found in scheduledMails/guestIntelligence");
  if (!recipients.length) throw new Error("No sendList configuration found in scheduledMails/guestIntelligence");

  const apiKey = String(RESEND_API_KEY.value() || "").trim();
  const from = String(RESEND_FROM.value() || "").trim();
  if (!apiKey) throw new Error("Missing RESEND_API_KEY secret");
  if (!from) throw new Error("Missing RESEND_FROM secret");

  const reports = await Promise.all(hotelUids.map((hotelUid) => getLatestGuestIntelligence(hotelUid, firestore)));
  const reportDates = reports.map((report) => report.reportDate).filter(Boolean).sort();
  const dateSuffix = reportDates.length ? reportDates.at(-1) : "no recent data";
  const response = await new ResendClass(apiKey).emails.send({
    from,
    to: recipients,
    subject: `Guest Intelligence Overview — ${dateSuffix}`,
    html: buildEmailHtml(reports),
    text: buildEmailText(reports),
  });

  await firestore.doc(SCHEDULED_MAIL_DOC_PATH).set({
    lastSentAt: admin.firestore.FieldValue.serverTimestamp(),
    lastSentTo: recipients,
    lastHotelUid: hotelUids,
    lastGuestCount: reports.reduce((total, report) => total + report.guests.length, 0),
    lastMailId: response?.data?.id || null,
    lastRunStatus: "sent",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  logger.info("Scheduled guest intelligence overview sent", { hotelCount: reports.length, recipientCount: recipients.length });
  return response;
}

const sendScheduledGuestIntelligenceMail = onSchedule({
  schedule: "30 4 * * *",
  timeZone: DEFAULT_TIMEZONE,
  timeoutSeconds: 540,
  secrets: [RESEND_API_KEY, RESEND_FROM],
}, async () => sendGuestIntelligenceMail());

module.exports = {
  buildEmailHtml,
  buildEmailText,
  getLatestGuestIntelligence,
  sanitizeArray,
  sendGuestIntelligenceMail,
  sendScheduledGuestIntelligenceMail,
  sortGuestsByConfidence,
};
