const { HttpsError } = require("firebase-functions/v2/https");
const { digest, text } = require("./validation");
const { validTimeZone } = require("./hotelSetupPolicy");
const currencyCodes = new Set(Intl.supportedValuesOf("currency"));
function hotelCurrency(value) {
  const currency = text(value, "Hotel currency", 3, true);
  if (!currencyCodes.has(currency)) throw new HttpsError("invalid-argument", "Choose a supported ISO currency from the list.");
  return currency;
}
function settingsFingerprint(hotel, bootstrap) {
  return digest(hotel.timeZone ?? null, hotel.currency ?? null, bootstrap.exists, bootstrap.data()?.currency ?? null);
}
function propertySettings(hotel, bootstrap) {
  const rawCurrency = bootstrap.exists ? bootstrap.data()?.currency : hotel.currency;
  const currency = typeof rawCurrency === "string" && /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : null;
  return { timeZone: validTimeZone(hotel.timeZone) ? hotel.timeZone : null,
    legacyTimeZone: validTimeZone(hotel.platformDetails?.timeZone) ? hotel.platformDetails.timeZone : null,
    currency, currencyConflict: bootstrap.exists && hotel.currency != null && hotel.currency !== rawCurrency,
    settingsFingerprint: settingsFingerprint(hotel, bootstrap) };
}
module.exports = { hotelCurrency, settingsFingerprint, propertySettings };
