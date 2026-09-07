const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildEmailHtml,
  buildEmailText,
  sanitizeArray,
  sortGuestsByConfidence,
} = require("./guestIntelligenceMail");

test("sanitizeArray accepts unique, non-empty configured values", () => {
  assert.deepEqual(sanitizeArray([" hotel-a ", "hotel-a", "", null, "hotel-b"]), ["hotel-a", "hotel-b"]);
  assert.deepEqual(sanitizeArray("hotel-a"), []);
});

test("sortGuestsByConfidence orders identity then VIP confidence", () => {
  const guests = [
    { fullName: "Low", identityConfidence: "low", vipConfidence: "high" },
    { fullName: "Medium low", identityConfidence: "medium", vipConfidence: "low" },
    { fullName: "High", identityConfidence: "high", vipConfidence: "low" },
    { fullName: "Medium high", identityConfidence: "medium", vipConfidence: "high" },
    { fullName: "Unknown" },
  ];
  assert.deepEqual(sortGuestsByConfidence(guests).map(({ fullName }) => fullName), [
    "High", "Medium high", "Medium low", "Low", "Unknown",
  ]);
});

test("email renderers create a clear overview and escape untrusted values", () => {
  const reports = [{
    hotelName: "Hotel <Central>",
    reportDate: "2026-09-06",
    guests: [{
      fullName: "Ada & Co",
      arrivalDate: "2026-09-10",
      departureDate: "2026-09-15",
      nights: 5,
      identityConfidence: "high",
      vipConfidence: "medium",
      isVip: true,
      jobTitle: "CTO",
      employer: "Example",
      professionalProfile: "Technologist",
      notableFacts: ["Pioneer"],
      sources: [{ title: "Profile", url: "https://example.com/profile" }, { title: "Bad", url: "javascript:alert(1)" }],
    }],
  }];

  const html = buildEmailHtml(reports);
  assert.match(html, /Hotel &lt;Central&gt;/);
  assert.match(html, /Ada &amp; Co/);
  assert.match(html, /Identity confidence:<\/strong> High/);
  assert.match(html, /https:\/\/example.com\/profile/);
  assert.doesNotMatch(html, /javascript:/);

  const text = buildEmailText(reports);
  assert.match(text, /Hotel <Central> — 2026-09-06/);
  assert.match(text, /identity: High \| VIP: yes/);
});
