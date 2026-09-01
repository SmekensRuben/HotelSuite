const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateNights, reservationCandidates, researchGuests } = require("./guestIntelligence");

test("calculateNights handles date-only stay boundaries", () => {
  assert.equal(calculateNights("2026-09-01", "2026-09-05"), 4);
  assert.equal(calculateNights("invalid", "2026-09-05"), null);
  assert.equal(calculateNights("2026-09-05", "2026-09-01"), null);
});

test("reservationCandidates requires a name and at least four nights", () => {
  const docs = [
    { id: "long", data: () => ({ fullName: " Ada Lovelace ", arrivalDate: "2026-09-01", departureDate: "2026-09-05" }) },
    { id: "short", data: () => ({ fullName: "Grace Hopper", arrivalDate: "2026-09-01", departureDate: "2026-09-04" }) },
    { id: "anonymous", data: () => ({ arrivalDate: "2026-09-01", departureDate: "2026-09-10" }) },
  ];
  assert.deepEqual(reservationCandidates({ docs }), [{
    reservationId: "long",
    fullName: "Ada Lovelace",
    arrivalDate: "2026-09-01",
    departureDate: "2026-09-05",
    nights: 4,
  }]);
});

test("researchGuests sends a web-enabled structured response request", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ output_text: JSON.stringify({ guests: [{ reservationId: "r1" }] }) }) };
  };
  const result = await researchGuests("secret", "gpt-5.6-terra", [{ reservationId: "r1", fullName: "Test Guest" }], fetchImpl);
  assert.deepEqual(result, [{ reservationId: "r1" }]);
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.options.headers.Authorization, "Bearer secret");
  assert.equal(request.body.tools[0].type, "web_search");
  assert.equal(request.body.tools[0].search_context_size, "high");
  assert.equal(request.body.reasoning.effort, "high");
  assert.equal(request.body.text.format.type, "json_schema");
});

test("researchGuests omits reasoning for older non-reasoning models", async () => {
  let body;
  const fetchImpl = async (_url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ output_text: JSON.stringify({ guests: [] }) }) };
  };
  await researchGuests("secret", "gpt-4.1-mini", [], fetchImpl);
  assert.equal(body.reasoning, undefined);
});
