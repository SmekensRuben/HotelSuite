const { HttpsError } = require("firebase-functions/v2/https");
const policy = require("./productPolicy");
const { supplierAiSourceDeclarations } = require("./supplierAiSourceDeclarations");

const NORMALIZATION_VERSION = 2;
const RAW_FIELDS = ["supplierSku", "supplierProductName", "currency", "pricingModel", "purchaseUnit", "baseUnit", "priceBasis", "gtin",
  "priceValidFrom", "priceValidUntil", "pricePerBaseUnit", "pricePerPurchaseUnit", "baseUnitsPerPurchaseUnit", "vatRate"];
const UNIT_ALIASES = { g: "g", gr: "g", gram: "g", grams: "g", gramme: "g", grammes: "g", kg: "kg", kilo: "kg", kilogram: "kg", kilograms: "kg",
  ml: "ml", milliliter: "ml", millilitre: "ml", milliliters: "ml", millilitres: "ml", l: "l", lt: "l", ltr: "l", liter: "l", litre: "l", liters: "l", litres: "l",
  each: "each", ea: "each", st: "each", stuk: "each", stuks: "each", piece: "each", pieces: "each", pcs: "each" };
const PURCHASE_ALIASES = { ds: "Box", doos: "Box", box: "Box", pk: "Pack", pak: "Pack", pack: "Pack", pakket: "Pack",
  fl: "Bottle", fles: "Bottle", bottle: "Bottle", st: "Piece", stuk: "Piece", piece: "Piece", each: "Piece" };
const plain = (value) => String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
const unitOf = (value) => UNIT_ALIASES[plain(value).toLowerCase().replace(/\.$/, "")] || null;
function sourceCells(unit) {
  try { const cells = JSON.parse(unit.text); return Array.isArray(cells) && cells.length <= 128
    && cells.every((cell) => cell === null || ["string", "number", "boolean"].includes(typeof cell)) ? cells : null; } catch { return null; }
}
function priceNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const spelling = plain(value).replace(/^(?:EUR|USD|GBP|€|\$|£)\s*/i, "").replace(/\s*(?:EUR|USD|GBP|€|\$|£)$/i, "");
  // A single group such as 1,000 or 1.000 has no known decimal/thousands
  // contract. Numeric workbook cells and unambiguous 0,012 rates remain exact.
  if (/^[1-9]\d{0,2}[.,]\d{3}$/.test(spelling)) return null;
  return /^\d+(?:[.,]\d{1,6})?$/.test(spelling) ? Number(spelling.replace(",", ".")) : null;
}
const isPriceHeader = (header) => /\b(?:price|prijs|prix|tarief|unitprice|eenheidsprijs|stukprijs|aankoopprijs|inkoopprijs)\b/i.test(header)
  && !/\b(?:total|totaal|amount|bedrag|omzet|waarde|revenue|spend|annual|yearly|jaarlijks|jaarlijkse|average|gemiddelde?|avg|historical|historisch)\b/i.test(header);
const isStatisticHeader = (header) => /\b(?:total|totaal|amount|bedrag|omzet|waarde|revenue|spend|quantity|aantal|afname|verbruik|average|gemiddelde?|avg|historical|historisch)\b/i.test(header);
function relevantSources(raw, sourceUnits) {
  const trusted = new Set((raw.sourceAnchors || []).filter((anchor) => anchor.verified === true).map((anchor) => anchor.sourceId));
  const rows = sourceUnits.filter((unit) => trusted.has(unit.sourceId) && unit.contextOnly !== true && !/header$/.test(unit.sourceId));
  const headers = sourceUnits.filter((unit) => unit.contextOnly === true || /header$/.test(unit.sourceId) || /\(possible header\)$/.test(unit.anchor || ""));
  return { rows, headers, visual: (raw.sourceAnchors || []).some((anchor) => anchor.evidenceKind === "visual-page") };
}
function priceChannel(header, cells = [], labels = []) {
  const match = plain(header).match(/(?:\b(?:per|par)\s*|\/\s*)([a-z]+)\b/i);
  const label = match && PURCHASE_ALIASES[match[1].toLowerCase()];
  if (label) return { channel: "purchase", purchaseUnit: label, unit: null };
  const unit = match && unitOf(match[1]);
  if (unit) return { channel: "base", unit };
  if (/\b(?:purchase\s*price|aankoopprijs|inkoopprijs|(?:per|par)\s*(?:verpakking|package|purchase\s*unit))\b/i.test(header)) return { channel: "purchase", unit: null };
  if (/\b(?:unit\s*price|eenheidsprijs|stukprijs)\b/i.test(header)) {
    for (let index = 0; index < Math.min(cells.length, labels.length); index++) {
      if (!isPackageHeader(plain(labels[index]))) continue;
      const value = plain(cells[index]), candidate = PURCHASE_ALIASES[value.toLowerCase()] || (/^(?:case|carton|bag|tray|jar|can)$/i.test(value) ? value : null);
      if (candidate) return { channel: "purchase", purchaseUnit: candidate, unit: null, inferred: true };
    }
  }
  return { channel: "unknown", unit: null };
}
function headersFor(row, sources) {
  const sheet = row.sourceId.match(/^xlsx-sheet-\d+-/)?.[0];
  return sources.headers.filter((unit) => !sheet || unit.sourceId.startsWith(sheet));
}
function priceEvidence(value, sources, baseUnit) {
  let statistic = false, unknownChannel = false;
  for (const row of sources.rows) {
    const cells = sourceCells(row);
    if (cells) {
      for (const header of headersFor(row, sources)) {
        const labels = sourceCells(header); if (!labels) continue;
        for (let index = 0; index < Math.min(labels.length, cells.length); index++) {
          const sourceValue = priceNumber(cells[index]); if (sourceValue === null) continue;
          const label = plain(labels[index]);
          if (isPriceHeader(label)) {
            const contract = priceChannel(label, cells, labels);
            if (contract.channel === "unknown") { if (sourceValue === value) unknownChannel = true; continue; }
            let matches = sourceValue === value;
            try {
              if (!matches && contract.channel === "base" && unitOf(baseUnit) && policy.compatibleUnits(contract.unit, unitOf(baseUnit))) {
                matches = policy.derivedPrice(sourceValue, policy.convertQuantity(1, contract.unit, unitOf(baseUnit)), true) === value;
              }
              if (!matches) {
                const contents = packageQuantities(sources);
                if (contents.length === 1) {
                  if (contract.channel === "base" && policy.compatibleUnits(contract.unit, contents[0].unit)) {
                    matches = policy.derivedPrice(sourceValue, policy.convertQuantity(contents[0].quantity, contents[0].unit, contract.unit)) === value;
                  } else if (contract.channel === "purchase" && unitOf(baseUnit) && policy.compatibleUnits(contents[0].unit, unitOf(baseUnit))) {
                    matches = policy.derivedPrice(sourceValue, policy.convertQuantity(contents[0].quantity, contents[0].unit, unitOf(baseUnit)), true) === value;
                  }
                }
              }
            } catch { /* Unrepresentable rates remain unverified, never rounded into a physical content. */ }
            if (matches) return { kind: "unit-price", value: sourceValue, ...contract };
          }
          if (sourceValue === value && isStatisticHeader(label)) statistic = true;
        }
      }
    } else {
      const valueText = plain(row.text);
      for (const match of valueText.matchAll(/\b(?:price|prijs|prix|aankoopprijs|inkoopprijs)\s*[:=]?\s*(?:EUR|USD|GBP|€|\$|£)?\s*(\d+(?:[.,]\d{1,6})?)/gi)) {
        if (priceNumber(match[1]) === value && !/\b(?:total|totaal|average|gemiddeld|annual|yearly)\s*$/i.test(valueText.slice(Math.max(0, match.index - 20), match.index))) {
          const preceding = valueText.slice(Math.max(0, match.index - 15), match.index);
          if (/\bpurchase\s*$/i.test(preceding) || /^(?:aankoopprijs|inkoopprijs)/i.test(match[0])) return { kind: "unit-price", value, channel: "purchase", unit: null };
          unknownChannel = true;
        }
      }
    }
  }
  return { kind: unknownChannel ? "channel-unavailable" : statistic ? "statistics" : sources.visual ? "visual-unverified" : "unverified" };
}
function namedQuantities(value) {
  return [...plain(value).matchAll(/(\d+(?:[.,]\d+)?)\s*(kilograms?|kg|grams?|grammes?|gr|g|millilitres?|milliliters?|ml|litres?|liters?|ltr|lt|l|each|ea|pieces?|pcs|stuks?|st)\b/gi)]
    .map((match) => ({ quantity: priceNumber(match[1]), unit: unitOf(match[2]) }))
    .filter((entry) => Number.isFinite(entry.quantity) && entry.quantity > 0 && entry.unit);
}
const isPackageHeader = (label) => /\b(?:content|inhoud|pack\s*size|package|purchase\s*unit|aankoop\s*eenheid|verpakking|verpakkingsinhoud|net\s*weight|netto\s*gewicht|gewicht\s*per)\b/i.test(label)
  && !/\b(?:annual|yearly|jaarlijkse?|ordered|besteld|afname|verbruik|sales|sold|total|totaal)\b/i.test(label);
function packageCellQuantities(value) {
  const spelling = plain(value);
  if (/\d\s*[x×*]\s*\d/i.test(spelling)) {
    const match = spelling.match(/^(?:(?:DS|DOOS|BOX|PK|PAK|PACK|FL|FLES|BOTTLE)\s*)?(\d{1,6})\s*[x×*]\s*(\d+(?:[.,]\d{1,6})?)\s*([a-z]+)(?:\s*(?:CASE|BOX|DS|PACK|PK))?$/i);
    const unit = match && unitOf(match[3]);
    if (!match || !unit || Number(match[1]) < 1 || priceNumber(match[2]) === null) return [];
    try { return [{ quantity: policy.multiplyQuantities(Number(match[1]), priceNumber(match[2])), unit }]; } catch { return []; }
  }
  const named = namedQuantities(spelling);
  return named.length === 1 ? named : [];
}
function sourceSinglePiece(sources) {
  return sources.rows.some((row) => {
    const cells = sourceCells(row); if (!cells) return false;
    return headersFor(row, sources).some((header) => (sourceCells(header) || []).some((label, index) => isPackageHeader(plain(label))
      && /^(?:ST|STUK|PIECE|EACH|EA|PCS)$/i.test(plain(cells[index]))));
  });
}
function packageQuantities(sources) {
  const quantities = [];
  for (const row of sources.rows) {
    const cells = sourceCells(row);
    if (cells) {
      for (const cell of cells) {
        if (/^(?:DS|DOOS|BOX|PK|PAK|PACK|FL|FLES|BOTTLE)\s*\d/i.test(plain(cell))) {
          const named = packageCellQuantities(cell); if (named.length === 1) quantities.push(named[0]);
        }
      }
      for (const header of headersFor(row, sources)) {
        const labels = sourceCells(header); if (!labels) continue;
        for (let index = 0; index < Math.min(labels.length, cells.length); index++) {
          if (!isPackageHeader(plain(labels[index]))) continue;
          const named = packageCellQuantities(cells[index]);
          if (named.length === 1) quantities.push(named[0]);
          else if (!named.length && !/\d\s*[x×*]\s*\d/i.test(plain(cells[index]))) {
            const quantity = priceNumber(cells[index]), unit = unitOf(cells[index + 1]);
            if (quantity !== null && quantity > 0 && unit && !isStatisticHeader(plain(labels[index + 1]))) quantities.push({ quantity, unit });
          }
        }
      }
    } else {
      const named = namedQuantities(row.text.match(/\b(?:DS|DOOS|BOX|PK|PAK|PACK|FL|FLES|BOTTLE)\s*\d+(?:[.,]\d+)?\s*(?:KG|GR|G|ML|L)\b/i)?.[0] || "");
      if (named.length === 1) quantities.push(named[0]);
    }
  }
  return [...new Map(quantities.map((entry) => {
    try { const dimension = policy.units[entry.unit].dimension, canonical = dimension === "mass" ? "g" : dimension === "volume" ? "ml" : "each";
      return [canonical + ":" + policy.convertQuantity(entry.quantity, entry.unit, canonical), entry]; }
    catch { return [entry.unit + ":" + entry.quantity, entry]; }
  })).values()];
}
function namedQuantityInSource(quantity, unit, sources) {
  return sources.rows.some((row) => {
    const cells = sourceCells(row); let values;
    if (cells) {
      const indexes = new Set();
      for (const header of headersFor(row, sources)) (sourceCells(header) || []).forEach((label, index) => {
        if (/\b(?:name|naam|product|omschrijving|description|designation)\b/i.test(plain(label))) indexes.add(index);
      });
      values = [...indexes].map((index) => cells[index]);
    } else values = [row.text];
    return values.flatMap(namedQuantities).some((entry) => {
      try { return policy.convertQuantity(entry.quantity, entry.unit, unit) === quantity; } catch { return false; }
    });
  });
}
function displayName(value) {
  if (typeof value !== "string") return value;
  return plain(value).replace(/[\p{L}]+/gu, (word) => word === word.toUpperCase() && word !== word.toLowerCase()
    ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : word)
    .replace(/(\d(?:[.,]\d+)?\s*)(KG|GR|G|ML|LTR|LT|L)\b/gi, (_, amount, unit) => amount + (unitOf(unit) || unit.toLowerCase()));
}

function normalizeSupplierAiProposal(raw, { importSettings, sourceUnits = [] } = {}) {
  if (!importSettings || importSettings.policyVersion === 1) return raw;
  if (importSettings.policyVersion !== NORMALIZATION_VERSION || typeof raw !== "object" || !raw || Array.isArray(raw)
    || raw.normalizationVersion !== undefined) throw new HttpsError("failed-precondition", "This supplier import normalization policy is unavailable or was already applied.");
  const result = { ...raw, originalInput: Object.fromEntries(RAW_FIELDS.map((field) => [field, raw[field] ?? null])), normalizationVersion: NORMALIZATION_VERSION,
    normalizationFindings: [], packInference: null };
  const finding = (field, code, message, before, after, provenance = "source", severity = "info") => {
    result.normalizationFindings.push({ field, code, severity, message, before: before ?? null, after: after ?? null, provenance });
  };
  const change = (field, next, code, message, provenance = "source", severity = "info") => {
    if (result[field] !== next) { finding(field, code, message, result[field], next, provenance, severity); result[field] = next; }
  };
  const sources = relevantSources(raw, sourceUnits), originalName = raw.supplierProductName;
  if (typeof originalName === "string") {
    const expanded = originalName.replace(/\bROCH\.\s*BOTER(?=\s|\d|$)/gi, (match, offset) => "Rochefort Boter" + (/\d/.test(originalName[offset + match.length] || "") ? " " : ""));
    if (expanded !== originalName) change("supplierProductName", expanded, "approved-name-expansion", "The approved ROCH.BOTER abbreviation was expanded to Rochefort Boter. Confirm the product identity.", "approved-name-expansion", "warning");
    change("supplierProductName", displayName(result.supplierProductName), "display-name-normalized", "Capitalized display words and SI unit labels were standardized; supplier SKU and GTIN were preserved.");
  }
  if (typeof result.purchaseUnit === "string") {
    const label = plain(result.purchaseUnit), alias = label.match(/^(ds|doos|box|pk|pak|pack|pakket|fl|fles|bottle|st|stuk|piece|each)(?:\s*\d|$)/i);
    change("purchaseUnit", alias ? PURCHASE_ALIASES[alias[1].toLowerCase()] : label, "purchase-label-normalized", "The supplier purchase-package label was standardized in English; no additional purchase option was created.");
  }
  if (typeof result.baseUnit === "string") {
    const unit = unitOf(result.baseUnit);
    if (unit) change("baseUnit", unit, "base-unit-normalized", "The explicit source unit was mapped to a supported SI or item unit without changing its dimension.");
    else finding("baseUnit", "unsupported-source-unit", "The source unit is unsupported or ambiguous. Choose an explicitly supported unit before confirmation.", result.baseUnit, result.baseUnit, "source", "error");
  }
  const declarations = supplierAiSourceDeclarations({ rows: sources.rows, headers: sources.headers });
  for (const field of ["currency", "priceBasis", "vatRate"]) {
    if (declarations.ambiguousFields.includes(field)) finding(field, "ambiguous-source-declaration", "Explicit structured source declarations conflict or are invalid. Review the document's commercial declaration before confirmation.", result[field], result[field], "source", "error");
    else if (declarations[field] !== null) change(field, declarations[field], "commercial-declaration-from-source", "An explicit structured source declaration takes precedence over the model proposal and import fallback. Review the documented commercial contract.", "source", "warning");
  }
  if (typeof result.currency === "string") change("currency", plain(result.currency).toUpperCase(), "currency-normalized", "The explicit source currency code was standardized to uppercase.");
  if (result.currency === null || result.currency === "") change("currency", importSettings.currency, "currency-from-import-context", "Missing source currency uses the explicitly selected import currency; existing unpriced offers retain their prior financial terms.", "import-setting", "warning");
  else if (result.currency !== importSettings.currency) finding("currency", "currency-context-conflict", "The explicit source currency differs from the selected import context. Review the currency before confirmation.", result.currency, result.currency, "source", "error");
  if (typeof result.priceBasis === "string") change("priceBasis", plain(result.priceBasis).toLowerCase(), "price-basis-normalized", "The explicit source price basis was standardized.");
  if (result.priceBasis === null || result.priceBasis === "unknown" || result.priceBasis === "") {
    if (importSettings.priceBasis !== "unknown") change("priceBasis", importSettings.priceBasis, "basis-from-import-context", "Missing source price basis uses the explicitly selected import context; existing unpriced offers retain their prior financial terms.", "import-setting", "warning");
    else result.priceBasis = "unknown";
  } else if (importSettings.priceBasis !== "unknown" && result.priceBasis !== importSettings.priceBasis) finding("priceBasis", "basis-context-conflict", "The explicit source price basis differs from the selected import context. Review the contract before confirmation.", result.priceBasis, result.priceBasis, "source", "error");
  if (result.priceBasis === "gross" && result.vatRate === null && importSettings.vatRate !== null) change("vatRate", importSettings.vatRate, "vat-from-import-context", "Missing source VAT uses the explicitly selected VAT fraction. Confirm that this rate applies to the product.", "import-setting", "warning");
  else if (result.vatRate !== null && importSettings.vatRate !== null && result.vatRate !== importSettings.vatRate) finding("vatRate", "source-vat-retained", "The explicit source VAT takes precedence over the optional import fallback. Confirm that the document rate applies to this product.", result.vatRate, result.vatRate, "source", "warning");
  let establishedPriceModel = null;
  for (const [field, value] of [["pricePerBaseUnit", result.pricePerBaseUnit], ["pricePerPurchaseUnit", result.pricePerPurchaseUnit]]) {
    if (value === null) continue;
    const evidence = priceEvidence(value, sources, result.baseUnit);
    if (evidence.kind === "channel-unavailable") {
      change(field, null, "source-price-channel-unknown", "The source amount has no explicit base-unit or purchase-package price channel. A bare price cannot establish a priced offer; supply a reviewed contract.", "source", "warning");
    } else if (evidence.kind === "statistics" || evidence.kind === "unverified") {
      change(field, null, evidence.kind === "statistics" ? "statistical-amount-not-price" : "unit-price-unverified",
        evidence.kind === "statistics" ? "A quantity, spend or statistical amount is not a supplier unit price. The proposed price was removed and remains unknown."
          : "The proposed unit price cannot be established from an explicit source price field. It remains unknown until supplied or reviewed.", "source", "warning");
    } else if (evidence.kind === "visual-unverified") {
      finding(field, "visual-unit-price-unverified", "The price comes from an unverified visual source. Check its price channel, tax and validity in the original document.", value, value, "source", "warning");
    } else if (evidence.channel === "base") {
      const target = unitOf(result.baseUnit) || evidence.unit;
      if (!policy.compatibleUnits(evidence.unit, target)) {
        change(field, null, "price-unit-dimension-conflict", "The explicit price unit and inventory unit have incompatible dimensions. No mass, volume or item price conversion was guessed.", "source", "error");
      } else {
        try {
          const converted = policy.derivedPrice(evidence.value, policy.convertQuantity(1, evidence.unit, target), true);
          if (result.baseUnit === null) change("baseUnit", target, "base-unit-from-price-contract", "The explicit source price contract identifies a supported draft base unit.");
          if (field !== "pricePerBaseUnit") change(field, null, "price-channel-normalized", "The source price is per base unit rather than per purchase package. Its authoritative channel was corrected.", "source", "warning");
          change("pricePerBaseUnit", converted, "base-price-unit-converted", "The source price was converted within its physical dimension to the reviewed base unit; its package value is preserved.", "source", "warning");
          establishedPriceModel = "Per Base Unit";
          finding("pricePerBaseUnit", "source-unit-price", "The proposed price matches the explicit source base-unit price contract. Review currency, tax and validity.", converted, converted);
        } catch { change(field, null, "price-unit-conversion-unavailable", "The source price-unit conversion cannot be represented safely. Supply a reviewed price contract.", "source", "error"); }
      }
    } else if (evidence.purchaseUnit && evidence.purchaseUnit !== result.purchaseUnit) {
      change(field, null, "price-purchase-label-conflict", "The source price applies to a different purchasable package label. Review the package and price contract.", "source", "error");
    } else {
      if (field !== "pricePerPurchaseUnit") change(field, null, "price-channel-normalized", "The source price is per purchasable package rather than per base unit. Its authoritative channel was corrected.", "source", "warning");
      change("pricePerPurchaseUnit", evidence.value, "purchase-price-channel-recovered", "The explicit source price belongs to the purchasable supplier package.", "source", "warning");
      establishedPriceModel = "Per Purchase Unit";
      if (evidence.inferred) finding("pricingModel", "purchase-price-channel-inferred", "The unit price is interpreted per supplier purchase package because the same structured row explicitly identifies that purchase unit. Verify this interpretation.", null, "Per Purchase Unit", "inference", "warning");
      finding("pricePerPurchaseUnit", "source-unit-price", "The proposed price matches an explicit price field for the purchasable source package. Review currency, tax and validity.", evidence.value, evidence.value);
    }
  }
  if (establishedPriceModel) change("pricingModel", establishedPriceModel, "pricing-model-from-channel", "The pricing model follows the explicit source price channel and unit contract.", "source", "warning");
  if (!["Per Purchase Unit", "Per Base Unit", null].includes(result.pricingModel)) finding("pricingModel", "unsupported-pricing-model", "The source pricing model is not supported. Select a canonical price channel before confirmation.", result.pricingModel, result.pricingModel, "source", "error");
  else if (result.pricingModel === null) {
    if (result.pricePerPurchaseUnit !== null && result.pricePerBaseUnit === null) change("pricingModel", "Per Purchase Unit", "pricing-model-from-channel", "The pricing model follows the explicit source purchase-price channel.");
    else if (result.pricePerBaseUnit !== null && result.pricePerPurchaseUnit === null) change("pricingModel", "Per Base Unit", "pricing-model-from-channel", "The pricing model follows the explicit source base-unit-price channel.");
    else if (result.pricePerBaseUnit !== null) finding("pricingModel", "ambiguous-price-channel", "Both price channels were supplied without an authoritative basis. Select the correct pricing model before confirmation.", null, null, "source", "error");
    else change("pricingModel", "Per Purchase Unit", "inactive-draft-price-model", "An unpriced new offer uses Per Purchase Unit solely as an inactive draft contract; no price is invented and existing financial terms remain unchanged.", "inference", "warning");
  }
  if (result.pricePerBaseUnit === null && result.pricePerPurchaseUnit === null) finding("price", "source-price-missing", "The source has no established supplier unit price. New offers remain unpriced and cannot be ordered; existing prices are preserved.", null, null, "source", "warning");
  const quantities = namedQuantities(originalName), singlePack = ["Pack", "Bottle", "Piece"].includes(result.purchaseUnit), hasMultiplier = /\d+\s*[x×*]\s*\d+/i.test(originalName || "");
  let base = unitOf(result.baseUnit), quantity = result.baseUnitsPerPurchaseUnit;
  const explicitContents = packageQuantities(sources);
  if (!explicitContents.length && base === "each" && result.purchaseUnit === "Piece" && sourceSinglePiece(sources)) {
    change("baseUnitsPerPurchaseUnit", 1, "single-piece-content-inferred", "An explicit supplier ST/Piece purchase unit represents one item. No Box count or mass-to-item conversion was inferred.", "inference", "warning"); quantity = 1;
  }
  if (explicitContents.length === 1) {
    const content = explicitContents[0];
    if (!base && result.baseUnit === null) { change("baseUnit", content.unit, "full-package-unit-from-source", "An explicit source package-content field identifies the physical base unit."); base = content.unit; }
    if (base && policy.compatibleUnits(base, content.unit)) {
      try { change("baseUnitsPerPurchaseUnit", policy.convertQuantity(content.quantity, content.unit, base), "full-package-content-from-source", "The full package content comes from an explicit package field or purchase label; inner piece size and annual quantities were not substituted.", "source", "warning"); quantity = result.baseUnitsPerPurchaseUnit; }
      catch { finding("baseUnitsPerPurchaseUnit", "package-conversion-unavailable", "The explicit package content cannot be represented exactly in the proposed base unit.", quantity, quantity, "source", "error"); }
    } else if (base) finding("baseUnit", "package-dimension-conflict", "The explicit full package content and proposed base unit have different dimensions. No mass, volume or item conversion was guessed.", base, base, "source", "error");
  } else if (explicitContents.length > 1) {
    change("baseUnitsPerPurchaseUnit", null, "ambiguous-full-package-content", "Several explicit full-package contents conflict. Review the complete purchasable package before confirmation.", "source", "error"); quantity = null;
  } else if (quantity !== null && base && !sources.visual
    && !(base === "each" && result.purchaseUnit === "Piece" && sourceSinglePiece(sources))
    && !(singlePack && !hasMultiplier && quantities.length === 1 && namedQuantityInSource(quantity, base, sources))) {
    change("baseUnitsPerPurchaseUnit", null, "package-quantity-unverified", "The proposed full package content cannot be established from an explicit package field. Inner size or annual/ordered quantities cannot establish a Box's content.", "source", "warning"); quantity = null;
  }
  if (quantity !== null && base && base !== "each" && sources.visual) finding("baseUnitsPerPurchaseUnit", "visual-package-content-unverified", "The package content comes from an unverified visual source. Check the entire purchasable package in the original document.", quantity, quantity, "source", "warning");
  if (quantity === null && singlePack && !hasMultiplier && quantities.length === 1 && namedQuantityInSource(quantities[0].quantity, quantities[0].unit, sources)) {
    const named = quantities[0];
    if (!base && result.baseUnit === null) { change("baseUnit", named.unit, "single-pack-unit-inferred", "A single consumer package's explicit named content supplies its draft base unit. Verify the package.", "inference", "warning"); base = named.unit; }
    if (base && policy.compatibleUnits(base, named.unit)) {
      try { change("baseUnitsPerPurchaseUnit", policy.convertQuantity(named.quantity, named.unit, base), "single-pack-content-inferred", "A single consumer package's explicit named content supplies its draft quantity. Verify that this is the full purchasable package.", "inference", "warning"); quantity = result.baseUnitsPerPurchaseUnit; } catch { /* Domain validation keeps unsupported conversion blocked. */ }
    } else if (base) finding("baseUnit", "package-dimension-conflict", "The named package content and proposed base unit have different dimensions. No mass, volume or item conversion was guessed.", base, base, "source", "error");
  }
  if (quantity === null) finding("baseUnitsPerPurchaseUnit", "package-content-missing", "The full purchasable package content is unknown. A Box or ambiguous multipack cannot inherit a single piece's named weight.", null, null, "source", "error");
  if (base && base !== "each" && typeof quantity === "number" && quantity > 0 && quantities.length) {
    const pieces = quantities.filter((entry) => policy.compatibleUnits(base, entry.unit) && namedQuantityInSource(entry.quantity, entry.unit, sources)).filter((entry) => {
      try { return policy.convertQuantity(entry.quantity, entry.unit, base) < quantity; } catch { return false; }
    });
    const distinct = [...new Map(pieces.map((entry) => [entry.unit + ":" + entry.quantity, entry])).values()];
    if (distinct.length === 1) {
      const piece = distinct[0];
      try {
        const total = policy.convertQuantity(quantity, base, piece.unit), totalScaled = BigInt(Math.round(policy.decimal(total, "Package content") * 1000000)), pieceScaled = BigInt(Math.round(policy.decimal(piece.quantity, "Piece content") * 1000000));
        if (pieceScaled > 0n && totalScaled % pieceScaled === 0n && totalScaled / pieceScaled <= 1000000n) {
          result.packInference = { piecesPerPurchaseUnit: Number(totalScaled / pieceScaled), pieceQuantity: piece.quantity, pieceUnit: piece.unit, provenance: "source-name" };
          finding("packInference", "piece-count-inferred", "The named piece content divides the full package content exactly. This is review metadata; the inventory unit and purchasable package remain unchanged.", null, result.packInference, "inference", "warning");
        } else finding("packInference", "piece-count-not-integral", "Named piece content does not divide the full package exactly. No rounded piece count or separate purchase option was created.", null, null, "inference", "warning");
      } catch { finding("packInference", "piece-count-unavailable", "The piece count cannot be represented exactly. The physical package remains unchanged.", null, null, "inference", "warning"); }
    } else if (distinct.length > 1) finding("packInference", "ambiguous-piece-content", "Several named piece sizes could fit the full package. No piece count was guessed.", null, null, "inference", "warning");
  }
  return result;
}
const normalizeSupplierAiProposals = (rows, options) => rows.map((row) => normalizeSupplierAiProposal(row, options));
module.exports = { NORMALIZATION_VERSION, normalizeSupplierAiProposal, normalizeSupplierAiProposals };
