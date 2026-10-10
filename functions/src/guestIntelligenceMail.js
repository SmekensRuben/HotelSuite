const { hotelHasActiveSubscription } = require("./subscriptions");
const { resolveAuthorizedRecipients, configuredRecipientUids, deliverScheduledMail, stableDigest, hotelMailFailure, requireNoHotelMailFailures } = require("./scheduledMailDelivery");
const { getLatestDateCollection, candidateFingerprint, validateCandidates, isFutureExpiry, hotelDate } = require("./guestIntelligence");
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

function identityConfidence(guest) {
  return guest.identityConfidence ?? guest.confidence;
}

function vipConfidence(guest) {
  return guest.vipConfidence ?? guest.confidence;
}

function sortGuestsByConfidence(guests) {
  return [...guests].sort((left, right) => {
    const identityDifference = confidenceRank(identityConfidence(left)) - confidenceRank(identityConfidence(right));
    if (identityDifference) return identityDifference;
    const vipDifference = confidenceRank(vipConfidence(left)) - confidenceRank(vipConfidence(right));
    if (vipDifference) return vipDifference;
    return String(left.fullName || "").localeCompare(String(right.fullName || ""), "en", { sensitivity: "base" });
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
  const imageUrl = safeSourceUrl(guest.profileImageUrl);
  const imageSourceUrl = safeSourceUrl(guest.profileImageSourceUrl);
  const image = imageUrl ? `<div style="margin:0 0 12px">
    ${imageSourceUrl ? `<a href="${escapeHtml(imageSourceUrl)}">` : ""}<img src="${escapeHtml(imageUrl)}" alt="Public professional portrait of ${escapeHtml(optionalText(guest.fullName, "guest"))}" width="120" height="120" style="display:block;width:120px;height:120px;border-radius:8px;object-fit:cover;border:1px solid #e5e7eb" referrerpolicy="no-referrer">${imageSourceUrl ? "</a>" : ""}
  </div>` : "";

  return `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:12px 0">
    ${image}
    <h3 style="margin:0 0 8px;color:#111827">${escapeHtml(optionalText(guest.fullName, "Unknown guest"))}</h3>
    <p style="margin:4px 0"><strong>Stay:</strong> ${escapeHtml(optionalText(guest.arrivalDate))} – ${escapeHtml(optionalText(guest.departureDate))} (${escapeHtml(optionalText(guest.nights))} nights)</p>
    <p style="margin:4px 0"><strong>Position:</strong> ${escapeHtml(optionalText(guest.jobTitle))} at ${escapeHtml(optionalText(guest.employer))}</p>
    <p style="margin:4px 0"><strong>Identity confidence:</strong> ${confidenceLabel(identityConfidence(guest))} · <strong>VIP:</strong> ${vipLabel} (${confidenceLabel(vipConfidence(guest))})</p>
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
      `${guest.fullName || "Unknown guest"} | identity: ${confidenceLabel(identityConfidence(guest))} | VIP: ${guest.isVip === true ? "yes" : guest.isVip === false ? "no" : "unknown"} (${confidenceLabel(vipConfidence(guest))})`,
      `${optionalText(guest.jobTitle)} at ${optionalText(guest.employer)}`,
      optionalText(guest.professionalProfile, "No professional profile found."),
      safeSourceUrl(guest.profileImageUrl) ? `Photo: ${safeSourceUrl(guest.profileImageUrl)}` : null,
    ].filter(Boolean).join("\n"));
    return `${heading}\n${guests.join("\n\n")}`;
  }).join("\n\n---\n\n");
}

async function readGuestIntelligenceVersion(hotelUid, reportDate, firestore, now, transaction) {
  const unavailable = { hotelUid, reportDate: null, guests: [], status: "unavailable" };
  if (reportDate !== hotelDate(now)) return unavailable;
  const read = (reference) => transaction ? transaction.get(reference) : reference.get();
  const run = await read(firestore.doc(`hotels/${hotelUid}/guestIntelligenceRuns/${reportDate}`));
  const data = run.data();
  if (!run.exists || data.status !== "completed" || !/^[a-f0-9]{64}$/.test(data.versionId || "") || !isFutureExpiry(data.expiresAt, now)) return unavailable;
  const source = firestore.collection(`hotels/${hotelUid}/reports/arrivalsmadeyesterday/${reportDate}`).limit(2001);
  const candidates = validateCandidates(await read(source));
  if (candidateFingerprint(candidates, reportDate, data.model) !== data.sourceFingerprint) return unavailable;
  const versionRef = firestore.doc(`hotels/${hotelUid}/guestIntelligenceVersions/${data.versionId}`);
  const [version, guestSnapshot] = await Promise.all([read(versionRef), read(versionRef.collection("guests"))]);
  if (!version.exists || version.data().status !== "completed" || version.data().sourceFingerprint !== data.sourceFingerprint || !isFutureExpiry(version.data().expiresAt, now)) return unavailable;
  const guests = guestSnapshot.docs.map((document) => ({ reservationId: document.id, ...document.data() }));
  if (!Number.isSafeInteger(data.writtenCount) || data.writtenCount < 0 || guests.length !== data.writtenCount || guests.length !== candidates.length
    || guests.some((guest) => !isFutureExpiry(guest.expiresAt, now) || guest.sourceFingerprint !== data.sourceFingerprint)) return unavailable;
  if (stableDigest(guests.map(({ reservationId }) => reservationId).sort()) !== stableDigest(candidates.map(({ reservationId }) => reservationId).sort())) return unavailable;
  return { hotelUid, reportDate, versionId: data.versionId, sourceFingerprint: data.sourceFingerprint, expiresAt: data.expiresAt, status: "completed", guests: sortGuestsByConfidence(guests) };
}

async function getLatestGuestIntelligence(hotelUid, firestore = db, now = Date.now()) {
  const latestSource = await getLatestDateCollection(firestore.doc(`hotels/${hotelUid}/reports/arrivalsmadeyesterday`));
  const hotelSnapshot = await firestore.doc(`hotels/${hotelUid}`).get();
  const hotelName = optionalText(hotelSnapshot.data()?.hotelName, hotelUid);
  if (!latestSource) return { hotelUid, hotelName, reportDate: null, guests: [], status: "unavailable" };
  return { ...(await readGuestIntelligenceVersion(hotelUid, latestSource.id, firestore, now)), hotelName };
}

function guestMailWindowOpen(now) {
  const parts = new Intl.DateTimeFormat("en", { timeZone: DEFAULT_TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return Number(values.hour) * 60 + Number(values.minute) >= 4 * 60 + 30;
}

async function sendGuestIntelligenceMail({ firestore = db, auth = admin.auth(), ResendClass = Resend, send, from: configuredFrom, now = Date.now, log = logger } = {}) {
  if (!guestMailWindowOpen(now())) return [{ status: "delivery-window-closed" }];
  const configurationSnapshot = await firestore.doc(SCHEDULED_MAIL_DOC_PATH).get();
  if (!configurationSnapshot.exists) return null;
  const configuration = configurationSnapshot.data() || {};
  const hotelUids = sanitizeArray(configuration.hotelUid);
  const apiKey = send ? "test-transport" : String(RESEND_API_KEY.value() || "").trim();
  const from = configuredFrom || String(RESEND_FROM.value() || "").trim();
  if (!apiKey || !from) throw new Error("Guest intelligence email configuration is incomplete.");
  const results = [];
  const failures = [];
  for (const hotelUid of hotelUids) {
    try {
      if (!await hotelHasActiveSubscription(firestore, hotelUid)) { results.push({ hotelUid, status: "subscription-inactive" }); continue; }
      const report = await getLatestGuestIntelligence(hotelUid, firestore, now());
      if (report.status !== "completed") { results.push({ hotelUid, status: "source-unavailable" }); continue; }
      const to = await resolveAuthorizedRecipients({ db: firestore, auth, hotelUid, recipientUids: configuredRecipientUids(configuration, hotelUid), feature: "reservations" });
      if (!to.length) { results.push({ hotelUid, status: "no-authorized-recipient" }); continue; }
      // Resolve each hotel's current recipients independently; never attach another hotel's guest report.
      const response = await deliverScheduledMail({ db: firestore, hotelUid, deliveryKey: `guestIntelligence/${report.versionId}`, now,
        validateClaim: async (transaction) => {
          const currentTo = await resolveAuthorizedRecipients({ db: firestore, auth, hotelUid, recipientUids: configuredRecipientUids(configuration, hotelUid), feature: "reservations", transaction });
          if (stableDigest(currentTo) !== stableDigest(to)) return false;
          const current = await readGuestIntelligenceVersion(hotelUid, report.reportDate, firestore, now(), transaction);
          return current.status === "completed" && current.versionId === report.versionId && current.sourceFingerprint === report.sourceFingerprint
            && stableDigest(current.guests) === stableDigest(report.guests);
        },
        send: send || ((payload, options) => new ResendClass(apiKey).emails.send(payload, options)), payload: {
          from, to, subject: `Guest Intelligence Overview — ${report.reportDate}`, html: buildEmailHtml([report]), text: buildEmailText([report]),
        } });
      if (response.skipped) { results.push({ hotelUid, status: "source-unavailable" }); continue; }
      await firestore.doc(SCHEDULED_MAIL_DOC_PATH).set({ lastSentAt: new Date(now()), lastHotelUid: [hotelUid], lastGuestCount: report.guests.length,
        lastMailId: response.data.id, lastRunStatus: "sent", lastVersionId: report.versionId }, { merge: true });
      results.push({ hotelUid, status: "sent", providerId: response.data.id, duplicate: response.duplicate === true });
    } catch (error) {
      const failure = hotelMailFailure(hotelUid, error);
      failures.push(failure); results.push(failure);
      log.error("Guest mail hotel delivery failed", failure);
    }
  }
  const sent = results.filter((result) => result.status === "sent").length;
  await firestore.doc(SCHEDULED_MAIL_DOC_PATH).set({ lastRunStatus: failures.length ? (sent ? "partial-failure" : "failed") : (sent ? "sent" : "no-delivery"), lastHotelResults: results.map(({ hotelUid, status, code, receiptId }) => ({ hotelUid, status, ...(code ? { code } : {}), ...(receiptId ? { receiptId } : {}) })) }, { merge: true });
  log.info("Guest mail scan completed", { hotelCount: hotelUids.length, sentHotelCount: sent, failedHotelCount: failures.length });
  requireNoHotelMailFailures(failures);
  return results;
}

const sendScheduledGuestIntelligenceMail = onSchedule({
  schedule: "every 30 minutes",
  timeZone: DEFAULT_TIMEZONE,
  timeoutSeconds: 540,
  secrets: [RESEND_API_KEY, RESEND_FROM],
}, async () => sendGuestIntelligenceMail());

module.exports = {
  buildEmailHtml,
  buildEmailText,
  getLatestGuestIntelligence,
  guestMailWindowOpen,
  sanitizeArray,
  sendGuestIntelligenceMail,
  sendScheduledGuestIntelligenceMail,
  sortGuestsByConfidence,
};
