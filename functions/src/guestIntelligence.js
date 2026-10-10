const { hotelHasActiveSubscription } = require("./subscriptions");
const { getFirestore } = require("firebase-admin/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { randomUUID } = require("node:crypto");
const { stableDigest, hotelBusinessDate: hotelDate } = require("./scheduledMailDelivery");
const logger = require("firebase-functions/logger");

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MINIMUM_NIGHTS = 4;
const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5.6-terra";
const RESEARCH_POLICY_VERSION = "professional-research-v2";
// Expire reads after 23 hours; hourly cleanup leaves a one-hour deletion budget within the 24-hour policy.
const RETENTION_MS = 23 * 60 * 60 * 1000;
const LEASE_MS = 9 * 60 * 1000;
const MAX_CANDIDATES = 400;
const MAX_UNIQUE_SUBJECTS = 120;
const MAX_RESEARCH_REQUESTS_PER_PASS = 8;
const MAX_SOURCE_RESERVATIONS = 2000;

function calculateNights(arrivalDate, departureDate) {
  if (!DATE_KEY_PATTERN.test(String(arrivalDate || "")) || !DATE_KEY_PATTERN.test(String(departureDate || ""))) {
    return null;
  }
  const arrival = Date.parse(`${arrivalDate}T00:00:00.000Z`);
  const departure = Date.parse(`${departureDate}T00:00:00.000Z`);
  if (!Number.isFinite(arrival) || !Number.isFinite(departure) || new Date(arrival).toISOString().slice(0, 10) !== arrivalDate
    || new Date(departure).toISOString().slice(0, 10) !== departureDate) return null;
  const nights = (departure - arrival) / 86400000;
  return Number.isInteger(nights) && nights >= 0 ? nights : null;
}

async function getLatestDateCollection(reportReference) {
  const collections = await reportReference.listCollections();
  return collections
    .filter(({ id }) => DATE_KEY_PATTERN.test(id))
    .sort((a, b) => b.id.localeCompare(a.id))[0] || null;
}

function reservationCandidates(snapshot) {
  return snapshot.docs.flatMap((document) => {
    const data = document.data();
    const fullName = String(data?.fullName || "").trim();
    const roomCategoryLabel = String(data?.roomCategoryLabel || "").trim().toUpperCase();
    const nights = calculateNights(data?.arrivalDate, data?.departureDate);
    if (!fullName || ["PM", "PR"].includes(roomCategoryLabel) || nights === null || nights < MINIMUM_NIGHTS) return [];
    return [{
      reservationId: document.id,
      fullName,
      arrivalDate: data.arrivalDate,
      departureDate: data.departureDate,
      nights,
    }];
  });
}

function normalizeGuestName(fullName) {
  return String(fullName || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

function groupCandidatesByName(candidates) {
  const groups = new Map();
  candidates.forEach((candidate) => {
    const key = normalizeGuestName(candidate.fullName);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  });
  return [...groups.values()];
}

function configuredHotelUids(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((hotelUid) => String(hotelUid || "").trim()).filter(Boolean))];
}

function analysisSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["guests"],
    properties: {
      guests: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["reservationId", "employer", "jobTitle", "professionalProfile", "notableFacts", "isVip", "vipReason", "identityNotes", "identityConfidence", "vipConfidence", "profileImageUrl", "profileImageSourceUrl", "sources"],
          properties: {
            reservationId: { type: "string" },
            employer: { type: ["string", "null"] },
            jobTitle: { type: ["string", "null"] },
            professionalProfile: { type: ["string", "null"] },
            notableFacts: { type: "array", items: { type: "string" } },
            isVip: { type: ["boolean", "null"] },
            vipReason: { type: ["string", "null"] },
            identityNotes: { type: ["string", "null"] },
            identityConfidence: { type: "string", enum: ["low", "medium", "high"] },
            vipConfidence: { type: ["string", "null"], enum: ["low", "medium", "high", null] },
            profileImageUrl: { type: ["string", "null"] },
            profileImageSourceUrl: { type: ["string", "null"] },
            sources: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["title", "url"],
                properties: { title: { type: "string" }, url: { type: "string" } },
              },
            },
          },
        },
      },
    },
  };
}

async function researchGuests(apiKey, model, guests, fetchImpl = fetch) {
  try {
    const isReasoningModel = /^gpt-5(?:\.|$)/.test(model);
    const response = await fetchImpl(OPENAI_API_URL, {
      method: "POST",
      signal: AbortSignal.timeout(60000),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        store: false,
        tools: [{ type: "web_search", search_context_size: "high" }],
        ...(isReasoningModel ? { reasoning: { effort: "high" } } : {}),
        input: [
          {
            role: "system",
            content: "Conduct thorough, multi-step research using only publicly available professional information. Search for each person separately, consult multiple independent and recent sources where possible, and distinguish people with the same name using employer, title, location and other public context. Never infer an employer or VIP status when identity is ambiguous. Summarize the person's career and relevant notable facts, but do not include sensitive personal data. VIP means a publicly notable senior executive, elected official, royal, celebrity, elite athlete, or another person whose public prominence may warrant special hotel attention. Return null for isVip and vipConfidence when evidence is insufficient. Report identityConfidence separately from vipConfidence: identityConfidence measures whether the public profile belongs to this guest, while vipConfidence measures confidence in the VIP classification after identity resolution. Explain identity uncertainty in identityNotes, and include direct public source URLs supporting every material conclusion. When a public professional headshot can be verified as belonging to the guest, return its direct HTTPS URL in profileImageUrl and the HTTPS page where it was found in profileImageSourceUrl. Otherwise return null for both image fields. Never return a social-media profile picture or an image when identity is uncertain.",
          },
          {
            role: "user",
            content: `Research these hotel guests and preserve each reservationId exactly:\n${JSON.stringify(guests.map(({ reservationId, fullName }) => ({ reservationId, fullName })))}`,
          },
        ],
        text: {
          format: { type: "json_schema", name: "guest_intelligence", strict: true, schema: analysisSchema() },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Research provider rejected the request (${response.status}).`);
    }
    const payload = await response.json();
    const outputText = payload.output_text || payload.output
      ?.flatMap((item) => item.content || [])
      .find((item) => item.type === "output_text")?.text;
    if (!outputText) throw new Error("OpenAI response did not contain output text");
    const parsed = JSON.parse(outputText);
    if (!Array.isArray(parsed?.guests)) throw new Error("Invalid research results.");
    return parsed.guests;
  } catch {
    // Provider/transport/parser exceptions can include request or generated guest text. Do not retain them.
    const error = new Error("Guest research provider response was unavailable or invalid.");
    error.code = "guest-research-unavailable";
    throw error;
  }
}

function timestampMillis(value) {
  try { return value?.toMillis?.() ?? (value instanceof Date ? value.getTime() : Number.NaN); }
  catch { return Number.NaN; }
}

function isFutureExpiry(value, now) {
  const expires = timestampMillis(value);
  return Number.isFinite(expires) && expires > now && expires <= now + RETENTION_MS;
}

function candidateFingerprint(candidates, reportDate, model) {
  return stableDigest([RESEARCH_POLICY_VERSION, reportDate, model, [...candidates].sort((a, b) => a.reservationId.localeCompare(b.reservationId))]);
}

function validateCandidates(snapshot) {
  if (snapshot.docs.length > MAX_SOURCE_RESERVATIONS) throw new Error("Guest source exceeds the bounded processing limit.");
  const candidates = reservationCandidates(snapshot).sort((a, b) => a.reservationId.localeCompare(b.reservationId));
  if (candidates.length > MAX_CANDIDATES || groupCandidatesByName(candidates).length > MAX_UNIQUE_SUBJECTS) throw new Error("Guest candidate count exceeds the bounded processing limit.");
  return candidates;
}

function researchResult(result, expectedId) {
  if (!result || result.reservationId !== expectedId || !["low", "medium", "high"].includes(result.identityConfidence)
    || ![true, false, null].includes(result.isVip) || !["low", "medium", "high", null].includes(result.vipConfidence)
    || !Array.isArray(result.notableFacts) || !Array.isArray(result.sources)) throw new Error("Research response did not contain a complete valid subject result.");
  const fields = ["employer", "jobTitle", "professionalProfile", "vipReason", "identityNotes", "profileImageUrl", "profileImageSourceUrl"];
  const output = {};
  for (const field of fields) {
    if (result[field] !== null && (typeof result[field] !== "string" || result[field].length > 10000)) throw new Error("Research response contains an invalid field.");
    output[field] = result[field];
  }
  if (result.notableFacts.length > 50 || result.notableFacts.some((v) => typeof v !== "string" || v.length > 2000)
    || result.sources.length > 50 || result.sources.some((v) => typeof v?.url !== "string" || v.url.length > 2000 || typeof v.title !== "string" || v.title.length > 1000)) throw new Error("Research response exceeds result limits.");
  return { ...output, notableFacts: result.notableFacts, sources: result.sources, isVip: result.isVip, identityConfidence: result.identityConfidence, vipConfidence: result.vipConfidence };
}

async function deleteCollection(db, collection, maxBatches = 100) {
  for (let page = 0; page < maxBatches; page += 1) {
    const snapshot = await collection.limit(400).get();
    if (!snapshot.docs.length) return;
    const batch = db.batch();
    snapshot.docs.forEach((document) => batch.delete(document.ref));
    await batch.commit();
  }
  throw new Error("Guest cleanup reached its bounded batch limit; operator continuation is required.");
}

async function cleanupGuestIntelligenceForHotel(hotelUid, { db = getFirestore(), now = Date.now } = {}) {
  // Query all version metadata, rather than only expiresAt, so pre-policy records cannot evade cleanup.
  const versions = await db.collection(`hotels/${hotelUid}/guestIntelligenceVersions`).limit(1001).get();
  if (versions.docs.length > 1000) throw new Error("Guest version cleanup needs operator pagination.");
  let removed = 0;
  for (const version of versions.docs) {
    if (isFutureExpiry(version.data()?.expiresAt, now())) continue;
    await deleteCollection(db, version.ref.collection("guests"));
    await deleteCollection(db, version.ref.collection("checkpoints"));
    await version.ref.delete();
    removed += 1;
  }
  // Old date-path records had no enforced expiry. Retire them; new mail uses immutable versions only.
  const legacyDates = await db.collection(`hotels/${hotelUid}/guestIntelligence`).listDocuments();
  for (const dateRef of legacyDates) {
    await deleteCollection(db, dateRef.collection("guests"));
    const pointer = await dateRef.get();
    if (pointer.exists && !isFutureExpiry(pointer.data()?.expiresAt, now())) await dateRef.delete();
  }
  const runs = await db.collection(`hotels/${hotelUid}/guestIntelligenceRuns`).limit(1001).get();
  if (runs.docs.length > 1000) throw new Error("Guest run cleanup needs operator pagination.");
  let removedRuns = 0;
  for (const run of runs.docs) {
    const deleted = await db.runTransaction(async (tx) => {
      const current = await tx.get(run.ref);
      if (!current.exists) return false;
      const data = current.data();
      const leaseUntil = timestampMillis(data.leaseUntil);
      const activeLease = data.status === "processing" && Number.isFinite(leaseUntil) && leaseUntil > now() && leaseUntil <= now() + LEASE_MS;
      if (isFutureExpiry(data.expiresAt, now()) || activeLease) return false;
      tx.delete(run.ref);
      return true;
    });
    if (deleted) removedRuns += 1;
  }
  return { hotelUid, removed, removedRuns };
}

async function processGuestIntelligenceForHotel(hotelUid, { db = getFirestore(), fetchImpl = fetch, now = Date.now, token = randomUUID() } = {}) {
  await cleanupGuestIntelligenceForHotel(hotelUid, { db, now });
  const report = db.doc(`hotels/${hotelUid}/reports/arrivalsmadeyesterday`);
  const latest = await getLatestDateCollection(report);
  if (!latest || latest.id !== hotelDate(now())) return { hotelUid, reportDate: latest?.id || null, candidates: 0, written: 0, status: "source-unavailable" };
  const apiKeySnapshot = await db.doc("apiKeys/hotelToolkitAIKey").get();
  const apiKey = String(apiKeySnapshot.data()?.value || "").trim();
  const model = String(apiKeySnapshot.data()?.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const sourceQuery = latest.limit(MAX_SOURCE_RESERVATIONS + 1);
  const candidates = validateCandidates(await sourceQuery.get());
  const fingerprint = candidateFingerprint(candidates, latest.id, model);
  const runRef = db.doc(`hotels/${hotelUid}/guestIntelligenceRuns/${latest.id}`);
  const claim = await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(runRef);
    const previous = snapshot.data() || {};
    if (previous.sourceFingerprint === fingerprint && previous.status === "completed" && isFutureExpiry(previous.expiresAt, now())) return { skip: true, ...previous };
    if (previous.status === "processing" && timestampMillis(previous.leaseUntil) > now()) return { busy: true };
    const resume = previous.sourceFingerprint === fingerprint && previous.versionId && isFutureExpiry(previous.expiresAt, now());
    const generation = resume ? previous.generation : (previous.generation || 0) + 1;
    const versionId = resume ? previous.versionId : stableDigest([latest.id, fingerprint, generation, token]);
    const expiresAt = resume ? previous.expiresAt : new Date(now() + RETENTION_MS);
    const data = { hotelUid, reportDate: latest.id, sourceFingerprint: fingerprint, versionId, generation, expiresAt, model, policyVersion: RESEARCH_POLICY_VERSION,
      status: "processing", token, leaseUntil: new Date(now() + LEASE_MS), candidateCount: candidates.length, uniqueCandidateCount: groupCandidatesByName(candidates).length };
    tx.set(runRef, data);
    tx.set(db.doc(`hotels/${hotelUid}/guestIntelligenceVersions/${versionId}`), { ...data, createdAt: new Date(now()) }, { merge: true });
    return data;
  });
  if (claim.busy) return { hotelUid, reportDate: latest.id, status: "busy" };
  if (claim.skip) return { hotelUid, reportDate: latest.id, candidates: claim.candidateCount, written: claim.writtenCount, versionId: claim.versionId, status: "unchanged" };
  const versionRef = db.doc(`hotels/${hotelUid}/guestIntelligenceVersions/${claim.versionId}`);
  try {
    if (candidates.length && !apiKey) throw new Error("apiKeys/hotelToolkitAIKey.value is missing");
    let requestsThisPass = 0;
    for (const group of groupCandidatesByName(candidates)) {
      const subjectId = stableDigest(normalizeGuestName(group[0].fullName));
      const checkpointRef = versionRef.collection("checkpoints").doc(subjectId);
      const checkpoint = await checkpointRef.get();
      if (checkpoint.exists) continue;
      if (requestsThisPass >= MAX_RESEARCH_REQUESTS_PER_PASS) {
        await db.runTransaction(async (tx) => {
          const run = await tx.get(runRef);
          if (run.data()?.token !== token || run.data()?.status !== "processing") throw new Error("Guest processing lease was lost.");
          tx.update(runRef, { status: "paused", leaseUntil: new Date(0) });
        });
        return { hotelUid, reportDate: latest.id, versionId: claim.versionId, status: "checkpointed" };
      }
      requestsThisPass += 1;
      // Dates, length of stay, hotel and internal reservation identifiers are unnecessary for public professional research.
      const subjects = [{ reservationId: subjectId, fullName: group[0].fullName }];
      const researched = await researchGuests(apiKey, model, subjects, fetchImpl);
      const result = researchResult(researched.find((item) => item.reservationId === subjectId), subjectId);
      await db.runTransaction(async (tx) => {
        const run = await tx.get(runRef);
        if (run.data()?.token !== token || run.data()?.status !== "processing" || !isFutureExpiry(claim.expiresAt, now())) throw new Error("Guest processing lease or retention window is no longer valid.");
        for (const candidate of group) tx.set(versionRef.collection("guests").doc(candidate.reservationId), { ...candidate, ...result, model,
          policyVersion: RESEARCH_POLICY_VERSION, sourceFingerprint: fingerprint, researchedAt: new Date(now()), expiresAt: claim.expiresAt });
        tx.set(checkpointRef, { completed: true, count: group.length, expiresAt: claim.expiresAt });
        tx.update(runRef, { leaseUntil: new Date(now() + LEASE_MS) });
      });
    }
    return await db.runTransaction(async (tx) => {
      const [run, freshSource] = await Promise.all([tx.get(runRef), tx.get(sourceQuery)]);
      if (run.data()?.token !== token || run.data()?.status !== "processing" || !isFutureExpiry(claim.expiresAt, now())) throw new Error("Guest run cannot be published after loss of its lease or expiry.");
      if (candidateFingerprint(validateCandidates(freshSource), latest.id, model) !== fingerprint) {
        tx.update(runRef, { status: "superseded", leaseUntil: new Date(0) });
        return { hotelUid, reportDate: latest.id, status: "source-changed" };
      }
      const completed = { status: "completed", writtenCount: candidates.length, completedAt: new Date(now()), leaseUntil: new Date(0) };
      tx.update(runRef, completed);
      tx.set(versionRef, completed, { merge: true });
      tx.set(db.doc(`hotels/${hotelUid}/guestIntelligence/${latest.id}`), { versionId: claim.versionId, sourceFingerprint: fingerprint, reportDate: latest.id, expiresAt: claim.expiresAt, status: "completed" });
      return { hotelUid, reportDate: latest.id, candidates: candidates.length, written: candidates.length, versionId: claim.versionId, status: "completed" };
    });
  } catch (error) {
    await db.runTransaction(async (tx) => {
      const run = await tx.get(runRef);
      if (run.data()?.token === token && run.data()?.status === "processing") tx.update(runRef, { status: "failed", leaseUntil: new Date(0), error: "Research failed; completed checkpoints are retained only until expiry." });
    });
    throw error;
  }
}

async function cleanupExpiredGuestIntelligence() {
  const db = getFirestore();
  const hotelSnapshot = await db.collection("hotels").get();
  for (const hotel of hotelSnapshot.docs) await cleanupGuestIntelligenceForHotel(hotel.id, { db });
}

async function processNightlyGuestIntelligence({ db = getFirestore(), processHotel = processGuestIntelligenceForHotel, log = logger } = {}) {
  const configuration = await db.doc("scheduledReports/guestIntelligence").get();
  const hotelUids = configuredHotelUids(configuration.data()?.hotelUid);
  if (!hotelUids.length) {
    logger.info("Guest intelligence skipped: no hotel UIDs configured");
    return;
  }

  for (const hotelUid of hotelUids) {
    try {
      if (!await hotelHasActiveSubscription(db, hotelUid)) continue;
      const result = await processHotel(hotelUid, { db });
      log.info("Guest intelligence completed", result);
    } catch {
      log.error("Guest intelligence failed", { hotelUid, code: "guest-intelligence-failed" });
    }
  }
}

exports.processNightlyGuestIntelligence = onSchedule(
  { schedule: "0 3 * * *", timeZone: "Europe/Brussels", timeoutSeconds: 540 },
  processNightlyGuestIntelligence
);
exports.calculateNights = calculateNights;
exports.reservationCandidates = reservationCandidates;
exports.normalizeGuestName = normalizeGuestName;
exports.groupCandidatesByName = groupCandidatesByName;
exports.configuredHotelUids = configuredHotelUids;
exports.researchGuests = researchGuests;
exports.processGuestIntelligenceForHotel = processGuestIntelligenceForHotel;

exports.cleanupExpiredGuestIntelligence = onSchedule({ schedule: "every 60 minutes", timeoutSeconds: 540 }, cleanupExpiredGuestIntelligence);
exports.cleanupGuestIntelligenceForHotel = cleanupGuestIntelligenceForHotel;
exports.candidateFingerprint = candidateFingerprint;
exports.validateCandidates = validateCandidates;
exports.getLatestDateCollection = getLatestDateCollection;
exports.timestampMillis = timestampMillis;
exports.isFutureExpiry = isFutureExpiry;
exports.processNightlyGuestIntelligenceHandler = processNightlyGuestIntelligence;
exports.hotelDate = hotelDate;
exports.RETENTION_MS = RETENTION_MS;

exports.resumeGuestIntelligenceRuns = onSchedule({ schedule: "every 30 minutes", timeoutSeconds: 540 }, processNightlyGuestIntelligence);
