const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MINIMUM_NIGHTS = 4;
const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-4.1-mini";
const BATCH_SIZE = 10;

function calculateNights(arrivalDate, departureDate) {
  if (!DATE_KEY_PATTERN.test(String(arrivalDate || "")) || !DATE_KEY_PATTERN.test(String(departureDate || ""))) {
    return null;
  }
  const arrival = Date.parse(`${arrivalDate}T00:00:00.000Z`);
  const departure = Date.parse(`${departureDate}T00:00:00.000Z`);
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
    const nights = calculateNights(data?.arrivalDate, data?.departureDate);
    if (!fullName || nights === null || nights < MINIMUM_NIGHTS) return [];
    return [{
      reservationId: document.id,
      fullName,
      arrivalDate: data.arrivalDate,
      departureDate: data.departureDate,
      nights,
    }];
  });
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
          required: ["reservationId", "employer", "jobTitle", "isVip", "vipReason", "confidence", "sources"],
          properties: {
            reservationId: { type: "string" },
            employer: { type: ["string", "null"] },
            jobTitle: { type: ["string", "null"] },
            isVip: { type: ["boolean", "null"] },
            vipReason: { type: ["string", "null"] },
            confidence: { type: "string", enum: ["low", "medium", "high"] },
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
  const response = await fetchImpl(OPENAI_API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      tools: [{ type: "web_search_preview", search_context_size: "medium" }],
      input: [
        {
          role: "system",
          content: "Research only publicly available professional information. Match names conservatively: never infer an employer or VIP status when identity is ambiguous. VIP means a publicly notable senior executive, elected official, royal, celebrity, elite athlete, or another person whose public prominence may warrant special hotel attention. Return null for isVip when there is insufficient evidence. Sources must be direct public URLs supporting the conclusion.",
        },
        {
          role: "user",
          content: `Research these hotel guests and preserve each reservationId exactly:\n${JSON.stringify(guests)}`,
        },
      ],
      text: {
        format: { type: "json_schema", name: "guest_intelligence", strict: true, schema: analysisSchema() },
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${body.slice(0, 500)}`);
  }
  const payload = await response.json();
  const outputText = payload.output_text || payload.output
    ?.flatMap((item) => item.content || [])
    .find((item) => item.type === "output_text")?.text;
  if (!outputText) throw new Error("OpenAI response did not contain output text");
  return JSON.parse(outputText).guests;
}

async function processGuestIntelligenceForHotel(hotelUid, { db = getFirestore(), fetchImpl = fetch } = {}) {
  const apiKeySnapshot = await db.doc("apiKeys/hotelToolkitAIKey").get();
  const apiKey = String(apiKeySnapshot.data()?.value || "").trim();
  if (!apiKey) throw new Error("apiKeys/hotelToolkitAIKey.value is missing");
  const model = String(apiKeySnapshot.data()?.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;

  const report = db.doc(`hotels/${hotelUid}/reports/arrivalsmadeyesterday`);
  const latest = await getLatestDateCollection(report);
  if (!latest) return { hotelUid, reportDate: null, candidates: 0, written: 0 };

  const candidates = reservationCandidates(await latest.get());
  const runRef = db.doc(`hotels/${hotelUid}/guestIntelligenceRuns/${latest.id}`);
  let written = 0;

  for (let offset = 0; offset < candidates.length; offset += BATCH_SIZE) {
    const batchCandidates = candidates.slice(offset, offset + BATCH_SIZE);
    const researched = await researchGuests(apiKey, model, batchCandidates, fetchImpl);
    const byId = new Map(researched.map((result) => [result.reservationId, result]));
    const batch = db.batch();
    batchCandidates.forEach((candidate) => {
      const result = byId.get(candidate.reservationId);
      if (!result) return;
      const destination = db.doc(`hotels/${hotelUid}/guestIntelligence/${latest.id}/guests/${candidate.reservationId}`);
      batch.set(destination, {
        ...candidate,
        employer: result.employer,
        jobTitle: result.jobTitle,
        isVip: result.isVip,
        vipReason: result.vipReason,
        confidence: result.confidence,
        sources: result.sources,
        researchedAt: FieldValue.serverTimestamp(),
        model,
      });
      written += 1;
    });
    await batch.commit();
  }

  await runRef.set({
    hotelUid,
    reportDate: latest.id,
    minimumNights: MINIMUM_NIGHTS,
    candidateCount: candidates.length,
    writtenCount: written,
    model,
    completedAt: FieldValue.serverTimestamp(),
  });
  return { hotelUid, reportDate: latest.id, candidates: candidates.length, written };
}

async function processNightlyGuestIntelligence() {
  const db = getFirestore();
  const hotels = await db.collection("hotels").get();
  for (const hotel of hotels.docs) {
    try {
      const result = await processGuestIntelligenceForHotel(hotel.id, { db });
      logger.info("Guest intelligence completed", result);
    } catch (error) {
      logger.error("Guest intelligence failed", { hotelUid: hotel.id, error: error.message });
    }
  }
}

exports.processNightlyGuestIntelligence = onSchedule(
  { schedule: "0 3 * * *", timeZone: "Europe/Brussels", timeoutSeconds: 540 },
  processNightlyGuestIntelligence
);
exports.calculateNights = calculateNights;
exports.reservationCandidates = reservationCandidates;
exports.researchGuests = researchGuests;
exports.processGuestIntelligenceForHotel = processGuestIntelligenceForHotel;
