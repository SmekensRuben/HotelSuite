"use strict";

// Suggestions are review assistance, never evidence that a price or an item has
// been approved. Physical identity is separate from a supplier's purchase box.
const policy = require("./productPolicy");
const { digest } = require("./validation");
const MAX_CATALOG_CANDIDATES = 500, MAX_SUGGESTIONS = 5;
const BRANDS = ["Coca-Cola", "Pepsi", "Galbani", "Zanetti", "President", "Campina", "Rochefort", "Heinz", "Hellmanns", "Devos Lemmens", "Lotus", "Lipton", "Evian", "Spa", "San Pellegrino", "Maes", "Jupiler", "Leffe", "Vedett", "Corona", "Heineken", "Fanta", "Sprite", "Schweppes", "Barilla", "De Cecco", "Mutti"];
const plain = (value) => typeof value === "string" ? value.normalize("NFC").trim() : "";
const words = (value) => plain(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9.,%]+/g, " ").replace(/\s+/g, " ").trim();
const bounded = (value, length) => plain(value).slice(0, length);
const contains = (text, value) => (` ${text} `).includes(` ${value} `);
const dimension = (value) => policy.units[value]?.dimension ?? null;
const defaultBaseUnit = (value) => dimension(value) === "mass" ? "kg" : dimension(value) === "volume" ? "l" : dimension(value) === "count" ? "each" : null;
const unique = (values) => [...new Set(values)].sort();
const ALIASES = { mozzarella: "mozzarella", mozarella: "mozzarella", melk: "milk", lait: "milk", milk: "milk", boter: "butter", beurre: "butter", butter: "butter", bloem: "flour", meel: "flour", farine: "flour", flour: "flour", tarwe: "wheat", ble: "wheat", wheat: "wheat", aardappel: "potato", aardappelen: "potato", potatoes: "potato", potato: "potato", tomaat: "tomato", tomaten: "tomato", tomato: "tomato", tomatoes: "tomato", water: "water", eau: "water", olie: "oil", huile: "oil", olijf: "olive", olijven: "olive", olive: "olive", olives: "olive", azijn: "vinegar", vinegar: "vinegar", peper: "pepper", pepper: "pepper", zout: "salt", sel: "salt", salt: "salt", suiker: "sugar", sucre: "sugar", sugar: "sugar", kaas: "cheese", fromage: "cheese", cheese: "cheese", room: "cream", creme: "cream", cream: "cream", koffie: "coffee", cafe: "coffee", coffee: "coffee", thee: "tea", the: "tea", tea: "tea", eieren: "egg", ei: "egg", eggs: "egg", egg: "egg", rund: "beef", rundvlees: "beef", beef: "beef", kip: "chicken", chicken: "chicken", rijst: "rice", riz: "rice", rice: "rice", zalm: "salmon", salmon: "salmon" };
const QUALIFIERS = {
  form: { sliced: /\b(?:sliced|slices|slice|gesneden|plakken|schijfjes|tranches)\b/, ground: /\b(?:ground|gemalen|moulu)\b/, grated: /\b(?:grated|geraspt|rape)\b/, diced: /\b(?:diced|blokjes|cubed|cubes)\b/, powder: /\b(?:powder|poeder|poudre)\b/, liquid: /\b(?:liquid|vloeibaar|liquide)\b/, whole: /\b(?:whole(?! (?:milk|grain|wheat))|heel|hele|bol|bollen|balls|ball|entier)\b/ },
  state: { frozen: /\b(?:frozen|diepvries|bevroren|surgeles?)\b/, fresh: /\b(?:fresh|vers|verse|frais|fraiche)\b/, dried: /\b(?:dried|gedroogd|seche)\b/ },
  organic: { organic: /\b(?:organic|biologisch|biologische|bio)\b/, conventional: /\b(?:conventional|non organic|not organic|niet biologisch)\b/ },
  gluten: { free: /\b(?:gluten free|glutenvrij|sans gluten)\b/, contains: /\b(?:contains gluten|with gluten|bevat gluten|wheat|tarwe|regular pasta|ordinary pasta|gewone pasta)\b/ },
  dairy: { free: /\b(?:dairy free|milk free|zuivelvrij|melkvrij|sans lait|vegan|veganistisch|plant based|plantaardig)\b/, contains: /\b(?:contains milk|with milk|bevat melk|cow milk|koemelk|buffalo milk|buffelmelk|dairy milk)\b/ },
  lactose: { free: /\b(?:lactose free|lactosevrij|sans lactose)\b/, contains: /\b(?:contains lactose|with lactose|regular milk|ordinary milk|gewone melk)\b/ },
  animalSource: { buffalo: /\b(?:buffalo|buffel|buffelmelk|bufala)\b/, cow: /\b(?:cow|koe|koemelk|vaccino)\b/, goat: /\b(?:goat|geit|geiten|geitenmelk|chevre)\b/, sheep: /\b(?:sheep|schaap|schapen|schapenmelk|brebis)\b/, plant: /\b(?:soy|soja|oat milk|havermelk|almond milk|amandelmelk|plant based|plantaardig|vegan)\b/ },
  plantSource: { soy: /\b(?:soy|soja|soymilk|sojamelk)\b/, oat: /\b(?:oat milk|havermelk|oatmilk)\b/, almond: /\b(?:almond milk|amandelmelk|almondmilk)\b/ },
  sugar: { zero: /\b(?:zero|sugar free|suikervrij|no sugar|zonder suiker|sans sucre|diet|light cola)\b/, regular: /\b(?:regular|original|classic|klassiek|klassieke|gewone cola|normal cola|with sugar|met suiker)\b/ },
  colaVariant: { zero: /\bzero\b/, diet: /\bdiet\b/, light: /\blight\b/, max: /\bmax\b/, classic: /\b(?:original|classic|klassiek|klassieke)\b/ },
  sweetener: { aspartame: /\baspartame\b/, stevia: /\bstevia\b/, sucralose: /\bsucralose\b/, saccharin: /\b(?:saccharin|saccharine)\b/ },
  productKind: { ketchup: /\bketchup\b/, puree: /\b(?:puree|pure)\b/, paste: /\b(?:tomato paste|tomatenconcentraat)\b/, soup: /\b(?:soup|soups|soep|potage)\b/,
    bread: /\b(?:bread|brood|pain)\b/, milk: /\b(?:milk|melk|lait|vollemelk|koemelk|buffelmelk|geitenmelk|schapenmelk|havermelk|sojamelk|amandelmelk)\b/,
    flour: /\b(?:flour|bloem|meel|farine)\b/, juice: /\b(?:juice|fruitjuice|sap|vruchtensap|sinaasappelsap|appelsap|orange juice|jus dorange)\b/,
    coffee: /\b(?:coffee|koffie|cafe)\b/, tea: /\b(?:tea|thee|the)\b/, water: /\b(?:water|eau)\b/, cheese: /\b(?:cheese|kaas|fromage|mozzarella|mozarella|gouda|brie|camembert)\b/,
    pasta: /\b(?:pasta|spaghetti|penne|macaroni|fusilli|tagliatelle)\b/, chocolate: /\b(?:milk chocolate|dark chocolate|white chocolate|melkchocolade|chocolade|chocolate(?! milk))\b/ },
  bones: { boneless: /\b(?:boneless|without bones|zonder bot|zonder been|uitgebeend)\b/, boneIn: /\b(?:bone in|with bones|met bot|met been)\b/ },
  carbonation: { sparkling: /\b(?:sparkling|carbonated|bruisend|bruis|gazeuse|met gas)\b/, still: /\b(?:still|flat water|plat water|non carbonated|not carbonated|niet bruisend|zonder bruis|non sparkling|not sparkling|without gas|zonder gas|no gas)\b/ },
  alcohol: { none: /\b(?:alcohol free|alcoholvrij|non alcoholic|sans alcool)\b/ },
  grade: { extraVirgin: /\b(?:extra virgin|extra vierge)\b/, virgin: /(?<!extra )\b(?:virgin|vierge)\b/, refined: /\b(?:refined|geraffineerd)\b/, premium: /\b(?:premium|extra quality)\b/, standard: /\b(?:standard grade|ordinary grade|standaardkwaliteit)\b/ },
};
const IMPORTANT = ["form", "state", "organic", "gluten", "dairy", "lactose", "animalSource", "plantSource", "sugar", "colaVariant", "sweetener", "productKind", "bones", "carbonation", "flavour", "flavourKind", "alcohol", "grade", "concentration", "fat", "allergens"];
const REMOVE_WORDS = new Set(["kg", "g", "gr", "gram", "grams", "kilogram", "kilograms", "ml", "cl", "l", "lt", "ltr", "liter", "litre", "liters", "litres", "each", "pcs", "pieces", "piece", "st", "stuk", "stuks", "x", "box", "boxes", "case", "cases", "carton", "pack", "packet", "bottle", "bottles", "doos", "dozen", "fles", "flessen", "ds", "pk", "fl", "bag", "tray", "bkt", "bucket", "jar", "tin", "can", "of", "de", "het", "van", "per"]);
const QUALIFIER_WORDS = new Set(["sliced", "slices", "slice", "gesneden", "plakken", "schijfjes", "tranches", "ground", "gemalen", "moulu", "grated", "geraspt", "rape", "diced", "blokjes", "cubed", "cubes", "whole", "heel", "hele", "bol", "bollen", "balls", "ball", "entier", "powder", "poeder", "poudre", "liquid", "vloeibaar", "liquide", "frozen", "diepvries", "bevroren", "surgele", "surgeles", "fresh", "vers", "verse", "frais", "fraiche", "dried", "gedroogd", "seche", "organic", "biologisch", "biologische", "bio", "conventional", "non", "not", "niet", "gluten", "free", "glutenvrij", "sans", "contains", "with", "bevat", "regular", "ordinary", "gewone", "dairy", "lactose", "lactosevrij", "milkfree", "dairyfree", "zuivelvrij", "melkvrij", "vegan", "veganistisch", "plant", "based", "plantaardig", "buffalo", "buffel", "bufala", "cow", "koe", "goat", "geit", "geiten", "chevre", "sheep", "schaap", "schapen", "brebis", "zero", "sugarfree", "suikervrij", "no", "zonder", "diet", "light", "original", "classic", "klassiek", "klassieke", "normal", "alcohol", "alcoholvrij", "alcoholic", "alcool", "extra", "virgin", "vierge", "refined", "geraffineerd", "premium", "quality", "grade", "standard", "standaardkwaliteit", "concentrated", "concentraat", "concentrate", "diluted", "ready", "drink", "to", "use"]);

function physicalNameQuantities(name) {
  const found = [];
  const text = words(name).replace(/(\d)(kg|gr|g|ml|cl|lt|ltr|l)\b/g, "$1 $2");
  for (const match of text.matchAll(/(?:\b(\d{1,6})\s*x\s*)?(\d+(?:[.,]\d{1,6})?)\s*(kg|gr|g|ml|cl|lt|ltr|l)\b/g)) {
    if (/^[1-9]\d{0,2}[.,]\d{3}$/.test(match[2])) continue;
    const value = Number(match[2].replace(",", ".")), unit = match[3] === "gr" ? "g" : ["lt", "ltr"].includes(match[3]) ? "l" : match[3] === "cl" ? "ml" : match[3];
    try {
      const amount = match[3] === "cl" ? policy.multiplyQuantities(value, 10) : value;
      const canonicalUnit = defaultBaseUnit(unit), canonicalQuantity = policy.convertQuantity(amount, unit, canonicalUnit);
      if (canonicalQuantity > 0) found.push({ dimension: dimension(unit), unit: canonicalUnit, quantity: canonicalQuantity, multiplier: Number(match[1] ?? 1) });
    } catch { /* Unrepresentable/ambiguous dimensions remain unknown. */ }
  }
  return [...new Map(found.map((item) => [item.unit + ":" + item.quantity, item])).values()];
}

function extractCatalogPhysicalIdentity(product = {}, { knownBrands = [] } = {}) {
  const name = bounded(product.supplierProductName ?? product.name, 200), text = words([name, bounded(product.description, 4000), bounded(product.storageType, 100)].filter(Boolean).join(" "));
  const explicitBrand = bounded(product.brand, 200), brands = unique([...BRANDS, ...knownBrands].map(words).filter(Boolean));
  const nameWords = words(name);
  const ambiguousBrandContexts = { spa: /\b(?:water|eau|reine|bruis|bruisend|sparkling|still)\b/, lotus: /\b(?:biscuit|biscuits|cookie|cookies|koek|koekjes|biscoff|speculoos|speculaas)\b/, president: /\b(?:cheese|kaas|fromage|butter|boter|cream|room|milk|melk|brie|camembert)\b/ };
  const named = brands.filter((brand) => contains(nameWords, brand) && (!ambiguousBrandContexts[brand] || ambiguousBrandContexts[brand].test(nameWords))).sort((a, b) => b.length - a.length);
  const brand = explicitBrand ? words(explicitBrand) : named[0] ?? null;
  const brandEvidence = explicitBrand ? "explicit-brand" : brand ? "source-name" : "unknown";
  const qualifiers = {};
  for (const [field, alternatives] of Object.entries(QUALIFIERS)) {
    qualifiers[field] = unique(Object.entries(alternatives).filter(([, pattern]) => pattern.test(field === "productKind" ? words(name) : text)).map(([value]) => value));
  }
  // In these common compounds the second noun identifies the article; the
  // ingredient or flavour word must not invent an additional product kind.
  if (/\b(?:milk chocolate|melkchocolade)\b/.test(words(name))) qualifiers.productKind = qualifiers.productKind.filter((value) => value !== "milk");
  if (/\b(?:cheese bread|kaasbrood|coffee bread|milk bread|melkbrood)\b/.test(words(name))) qualifiers.productKind = qualifiers.productKind.filter((value) => !["cheese", "coffee", "milk"].includes(value));
  // Negated declarations are not positive organic evidence.
  if (qualifiers.organic.includes("conventional")) qualifiers.organic = ["conventional"];
  if (qualifiers.carbonation.includes("still")) qualifiers.carbonation = ["still"];
  if (/\b(?:coffee|koffie|cafe)\b/.test(text) && /\b(?:beans|bonen|grains)\b/.test(text)) qualifiers.form = unique([...qualifiers.form, "beans"]);
  const dairyName = /\b(?:yogurt|yoghurt|yoghourt|milk|melk|cream|room|custard|vla|kwark|quark)\b/.test(text);
  qualifiers.flavour = dairyName ? unique(Object.entries({ strawberry: /\b(?:strawberry|strawberries|aardbei|aardbeien|fraise)\b/, vanilla: /\b(?:vanilla|vanille)\b/,
    chocolate: /\b(?:chocolate|chocolade|choco|chocolat)\b/, raspberry: /\b(?:raspberry|raspberries|framboos|frambozen|framboise)\b/ }).filter(([, pattern]) => pattern.test(text)).map(([value]) => value)) : [];
  qualifiers.flavourKind = dairyName ? unique([...(qualifiers.flavour.length || /\b(?:flavoured|flavored|met smaak)\b/.test(text) ? ["flavoured"] : []),
    ...(/\b(?:plain|unflavoured|unflavored|naturel|ongezoet natuur)\b/.test(text) ? ["plain"] : [])]) : [];
  const percentages = [], physicalDescription = words(bounded(product.description, 4000));
  for (const [declaredText, requirePhysicalLabel] of [[words(name), false], [physicalDescription, true]]) {
    for (const match of declaredText.matchAll(/\b(\d+(?:[.,]\d+)?)\s*%/g)) {
      const context = declaredText.slice(Math.max(0, match.index - 40), match.index + match[0].length + 24);
      if (/\b(?:discount|off|save|korting|promo|vat|btw|tax|incl|excl)\b/.test(context)) continue;
      if (requirePhysicalLabel && !/\b(?:concentration|concentratie|strength|abv|alcohol|alc|fat|vet|protein|cacao|solids|droge stof)\b/.test(context)) continue;
      const field = /\b(?:abv|alcohol|alc|beer|bier|wine|wijn|gin|vodka|rum)\b/.test(context) ? "alcohol" : /\b(?:fat|vet)\b/.test(context) ? "fat" : "concentration";
      percentages.push({ value: Number(match[1].replace(",", ".")), field });
    }
  }
  if (/\b(?:abv|alcohol|alc|beer|bier|heineken|jupiler|maes|leffe|corona)\b/.test(text) && /\b0[.,]0\b/.test(text)) qualifiers.alcohol = ["none"];
  qualifiers.concentration = unique([...(text.match(/\b(?:concentrated|concentrate|concentraat)\b/) ? ["concentrated"] : []), ...(text.match(/\b(?:ready to (?:drink|use)|diluted|verdund)\b/) ? ["ready-to-use"] : [])]);
  qualifiers.fat = unique([...(text.match(/\b(?:full fat|whole milk|volle melk|vollemelk)\b/) ? ["full"] : []), ...(text.match(/\b(?:skimmed|skim|fat free|magere melk|mager)\b/) ? ["skimmed"] : []), ...(text.match(/\b(?:semi skimmed|halfvolle melk|halfvol)\b/) ? ["semi"] : [])]);
  if (text.match(/\b(?:semi skimmed|halfvolle melk|halfvol)\b/)) qualifiers.fat = qualifiers.fat.filter((value) => value !== "skimmed");
  for (const item of percentages) qualifiers[item.field] = unique([...qualifiers[item.field], `percent:${item.value}`]);
  const allergenValues = Array.isArray(product.allergens) ? product.allergens.filter((value) => typeof value === "string").slice(0, 30).map(words).filter(Boolean) : [];
  qualifiers.allergens = unique(allergenValues.map((value) => ({ melk: "milk", lait: "milk", tarwe: "wheat", soja: "soy", soya: "soy", ei: "egg", eieren: "egg" }[value] ?? value)));
  let coreName = words(name).replace(/(?:\b\d{1,6}\s*x\s*)?\d+(?:[.,]\d+)?\s*(?:kg|gr|g|ml|cl|ltr|lt|l)\b/g, " ");
  if (brand) coreName = (` ${coreName} `).replace(` ${brand} `, " ");
  const extraAliases = { buffelmelk: "milk", koemelk: "milk", geitenmelk: "milk", schapenmelk: "milk", vollemelk: "milk", havermelk: "oatmilk", sojamelk: "soymilk", amandelmelk: "almondmilk", skimmed: "", skim: "", magere: "", mager: "", halfvolle: "", halfvol: "", volle: "", semi: "", max: "",
    brood: "bread", bread: "bread", pain: "bread", sap: "juice", vruchtensap: "juice", fruitjuice: "juice", sinaasappel: "orange", sinaasappels: "orange", jus: "juice", dorange: "orange",
    yoghurt: "yogurt", yoghourt: "yogurt", aardbei: "strawberry", aardbeien: "strawberry", fraise: "strawberry", vanille: "vanilla", chocolat: "chocolate", chocolade: "chocolate", choco: "chocolate", framboos: "raspberry", frambozen: "raspberry", framboise: "raspberry", soep: "soup", potage: "soup", grains: "beans", bonen: "beans", bruisend: "sparkling", gazeuse: "sparkling", naturel: "plain" };
  const compoundAliases = { sinaasappelsap: ["orange", "juice"], appelsap: ["apple", "juice"], melkchocolade: ["milk", "chocolate"], kaasbrood: ["cheese", "bread"], melkbrood: ["milk", "bread"] };
  const coreTokens = unique(coreName.split(" ").filter((word) => word && !REMOVE_WORDS.has(word) && !QUALIFIER_WORDS.has(word) && !/^\d+(?:[.,]\d+)?%?$/.test(word)).flatMap((word) => compoundAliases[word] ?? [extraAliases[word] ?? ALIASES[word] ?? word]).filter(Boolean));
  const namedQuantities = physicalNameQuantities(name);
  let eachSpec = null, eachSpecUnknown = false;
  if (dimension(product.baseUnit) === "count") {
    if (namedQuantities.length === 1) eachSpec = { unit: namedQuantities[0].unit, quantity: namedQuantities[0].quantity, dimension: namedQuantities[0].dimension };
    else eachSpecUnknown = true;
    // A reviewed each-spec is one inventory item; the supplier box quantity is
    // never copied here, even when it is a known number of bottles or pieces.
    if (!product.supplierProductName && typeof product.baseQtyPerUnit === "number") {
      if (product.baseQtyPerUnit !== 1) eachSpecUnknown = true;
    }
  }
  return { name, baseUnit: product.baseUnit ?? null, dimension: dimension(product.baseUnit), brand, brandEvidence,
    qualifiers, coreTokens, eachSpec, eachSpecUnknown, hasUnparsedNotes: Boolean(plain(product.notes)), packageGtin: bounded(product.gtin, 100) || null };
}

function similarity(left, right) {
  if (!left.length || !right.length) return 0;
  const a = new Set(left), b = new Set(right), intersection = left.filter((value) => b.has(value)).length;
  return intersection / (a.size + b.size - intersection);
}
function validConversion(supplierProduct, catalogProduct) {
  if (!policy.compatibleUnits(supplierProduct.baseUnit, catalogProduct.baseUnit)) return false;
  try {
    const quantity = policy.decimal(supplierProduct.baseUnitsPerPurchaseUnit, "Supplier package content", { positive: true });
    policy.convertQuantity(quantity, supplierProduct.baseUnit, catalogProduct.baseUnit); return true;
  } catch { return false; }
}
function compareIdentities(source, target, { allowDifferentBrands = false } = {}) {
  const conflicts = [], warnings = [], evidence = [];
  if (source.hasUnparsedNotes || target.hasUnparsedNotes) warnings.push("Additional product notes need review. Free-form notes are not interpreted as verified physical specifications.");
  if (!source.dimension || !target.dimension || source.dimension !== target.dimension) conflicts.push("The inventory units belong to different or unknown physical dimensions. No density or item-weight conversion is available.");
  if (source.brand && target.brand && source.brand !== target.brand) {
    if (allowDifferentBrands) warnings.push("The supplier brands differ. Link them to a generic catalog article only after explicitly reviewing their physical interchangeability.");
    else conflicts.push("The explicitly identified brands differ. Keep these physical articles separate.");
  }
  if (!source.brand || !target.brand) warnings.push("The brand is not established on both articles. Similar names alone do not prove interchangeability.");
  else if (source.brand === target.brand) evidence.push("The same brand is explicitly identified in the product data or names.");
  for (const field of IMPORTANT) {
    const a = source.qualifiers[field] || [], b = target.qualifiers[field] || [];
    if (a.length && b.length && JSON.stringify(a) !== JSON.stringify(b)) conflicts.push(`The declared ${field === "animalSource" ? "milk or animal source" : field} differs between these articles.`);
    else if (a.length !== b.length) warnings.push(`The ${field === "animalSource" ? "milk or animal source" : field} is not established on both articles. Check it before linking.`);
    else if (a.length) evidence.push(`The declared ${field === "animalSource" ? "milk or animal source" : field} agrees.`);
    if (field !== "allergens" && (a.length > 1 && new Set(a.map((item) => item.split(":")[0])).size > 1 || b.length > 1 && new Set(b.map((item) => item.split(":")[0])).size > 1)) warnings.push(`The ${field} contains several declarations and needs individual review.`);
  }
  const overlap = similarity(source.coreTokens, target.coreTokens), exactCore = JSON.stringify(source.coreTokens) === JSON.stringify(target.coreTokens) && source.coreTokens.length > 0;
  if (overlap === 0) warnings.push("The descriptions do not share established physical article words. Translations or synonyms require explicit physical review.");
  else if (!exactCore) warnings.push("The physical article descriptions are not identical. Check the actual goods, rather than a name similarity score.");
  else evidence.push("The normalized physical article description agrees after removing supplier package quantities.");
  if (source.dimension === "count" && target.dimension === "count") {
    if (source.eachSpec && target.eachSpec && JSON.stringify(source.eachSpec) !== JSON.stringify(target.eachSpec)) conflicts.push("One inventory item has a different physical size or measure. Different bottle or item sizes must remain separate each-based articles.");
    else if (!source.eachSpec || !target.eachSpec || source.eachSpecUnknown || target.eachSpecUnknown) warnings.push("The physical specification of one counted item is incomplete. A box quantity cannot establish interchangeability.");
    else evidence.push("One counted inventory item has the same explicit physical size.");
  }
  if (source.packageGtin && source.packageGtin === target.packageGtin) warnings.push("The GTIN agrees, but a supplier package barcode is not proof of the catalog physical article or its unit.");
  return { conflicts: unique(conflicts), warnings: unique(warnings), evidence: unique(evidence), overlap, exactCore };
}
function validateCatalogSyncSelection(supplierProduct, catalogProduct, { allowDifferentBrands = false } = {}) {
  if (!supplierProduct || !catalogProduct) return { allowed: false, reasons: ["Choose an existing supplier offer and a catalog article."], warnings: [], evidence: [] };
  const knownBrands = catalogProduct.brand ? [catalogProduct.brand] : [];
  const source = extractCatalogPhysicalIdentity(supplierProduct, { knownBrands }), target = extractCatalogPhysicalIdentity(catalogProduct, { knownBrands });
  const comparison = compareIdentities(source, target, { allowDifferentBrands: allowDifferentBrands === true });
  const reasons = [...comparison.conflicts];
  if (!validConversion(supplierProduct, catalogProduct)) reasons.push("The supplier package cannot be converted exactly to this inventory unit. Correct its known physical content first.");
  if (supplierProduct.archived === true) reasons.push("An archived supplier offer cannot receive a new catalog link.");
  if (catalogProduct.active === false || catalogProduct.archived === true) reasons.push("An archived or inactive catalog article cannot receive a new supplier link.");
  return { allowed: !reasons.length, reasons: unique(reasons), warnings: comparison.warnings, evidence: comparison.evidence,
    sourceIdentity: source, targetIdentity: target, exactCore: comparison.exactCore, overlap: comparison.overlap };
}
function proposedCatalogFor(supplierProduct) {
  const name = bounded(supplierProduct?.supplierProductName, 200), baseUnit = defaultBaseUnit(supplierProduct?.baseUnit);
  if (!name || !baseUnit) return null;
  try { const quantity = policy.decimal(supplierProduct.baseUnitsPerPurchaseUnit, "Supplier package content", { positive: true }); policy.convertQuantity(quantity, supplierProduct.baseUnit, baseUnit); }
  catch { return null; }
  // Catalog names retain the source wording so the reviewer can deliberately
  // choose a package-independent display name. No brand, taxonomy, GTIN or
  // allergen fact is fabricated from an offer or copied from its purchase box.
  return { name, baseUnit, baseQtyPerUnit: null };
}
function catalogSyncGroupKey(supplierProduct) {
  const identity = extractCatalogPhysicalIdentity(supplierProduct);
  if (!identity.dimension || !identity.brand || !identity.coreTokens.length || identity.eachSpecUnknown || identity.hasUnparsedNotes || identity.qualifiers.allergens.length === 0
    && (identity.qualifiers.dairy.length || identity.qualifiers.gluten.length)) return null;
  if (identity.dimension === "count" && !identity.eachSpec) return null;
  if (Object.entries(identity.qualifiers).some(([field, values]) => field !== "allergens" && values.length > 1)) return null;
  return digest("catalog-physical-group-v1", identity.dimension, identity.brand, identity.coreTokens, identity.qualifiers, identity.dimension === "count" ? identity.eachSpec : null);
}
function getCatalogSyncSuggestions(supplierProduct, catalogPool, { limit = MAX_SUGGESTIONS } = {}) {
  if (!Array.isArray(catalogPool) || catalogPool.length > MAX_CATALOG_CANDIDATES || !Number.isInteger(limit) || limit < 1 || limit > MAX_SUGGESTIONS) throw new RangeError("Use at most 500 scoped catalog candidates and one to five suggestions.");
  const source = extractCatalogPhysicalIdentity(supplierProduct), proposedCatalog = proposedCatalogFor(supplierProduct);
  if (supplierProduct?.catalogProductId) return { status: "review", candidates: [], proposedCatalog: null, physicalIdentity: source, groupKey: null, warnings: ["This supplier offer is already linked. Existing links are not changed by catalog sync."] };
  if (!proposedCatalog) return { status: "needs-unit-review", candidates: [], proposedCatalog: null, physicalIdentity: source, groupKey: null, warnings: ["The supplier offer needs a supported inventory dimension and an exact, positive package conversion before linking."] };
  const seen = new Set(), candidates = [];
  for (const record of catalogPool) {
    const catalogProductId = record?.id ?? record?.catalogProductId;
    if (typeof catalogProductId !== "string" || !catalogProductId || seen.has(catalogProductId)) continue;
    seen.add(catalogProductId);
    const verdict = validateCatalogSyncSelection(supplierProduct, record);
    const matchingBrand = verdict.sourceIdentity.brand && verdict.sourceIdentity.brand === verdict.targetIdentity.brand;
    if (!verdict.allowed || verdict.overlap < 0.5 && !matchingBrand) continue;
    const suggested = verdict.exactCore && verdict.warnings.length === 0 && verdict.sourceIdentity.brand && verdict.targetIdentity.brand;
    candidates.push({ catalogProductId, status: suggested ? "suggested" : "review", matchKind: suggested ? "physical-identity" : "description-overlap",
      score: Math.round((verdict.overlap * 70 + (verdict.exactCore ? 10 : 0) + (verdict.sourceIdentity.brand && verdict.sourceIdentity.brand === verdict.targetIdentity.brand ? 20 : 0)) * 1000) / 1000,
      reasons: verdict.evidence.length ? verdict.evidence : ["The descriptions share physical article words and their inventory dimensions convert exactly."], warnings: verdict.warnings,
      evidence: { sourceBrand: verdict.sourceIdentity.brand, catalogBrand: verdict.targetIdentity.brand, unitDimension: source.dimension,
        sourceQualifiers: verdict.sourceIdentity.qualifiers, catalogQualifiers: verdict.targetIdentity.qualifiers, sourceEachSpec: verdict.sourceIdentity.eachSpec, catalogEachSpec: verdict.targetIdentity.eachSpec } });
  }
  candidates.sort((a, b) => Number(b.status === "suggested") - Number(a.status === "suggested") || b.score - a.score || a.catalogProductId.localeCompare(b.catalogProductId, "en"));
  const top = candidates.slice(0, limit), status = top.some((candidate) => candidate.status === "suggested") ? "suggested" : top.length ? "review" : "new";
  const warnings = source.brand ? [] : ["The source brand is unknown. Review product identity and exchangeability before creating or linking a catalog article."];
  return { status, candidates: top, proposedCatalog, physicalIdentity: source, groupKey: catalogSyncGroupKey(supplierProduct), warnings };
}
function validateCatalogSyncModelProposal(supplierProduct, proposal, catalogPool) {
  if (!proposal || typeof proposal.catalogProductId !== "string" || !Array.isArray(catalogPool) || catalogPool.length > MAX_CATALOG_CANDIDATES) return { allowed: false, reasons: ["The model must select an existing candidate from the scoped catalog proposal pool."], warnings: [] };
  const matches = catalogPool.filter((product) => (product.id ?? product.catalogProductId) === proposal.catalogProductId);
  if (matches.length !== 1) return { allowed: false, reasons: ["The model selected an unknown or ambiguous catalog candidate."], warnings: [] };
  const verdict = validateCatalogSyncSelection(supplierProduct, matches[0]);
  return { ...verdict, warnings: unique([...verdict.warnings, "A model rank or confidence cannot approve a catalog link or override physical identity checks."]) };
}
module.exports = { MAX_CATALOG_CANDIDATES, MAX_SUGGESTIONS, extractCatalogPhysicalIdentity, getCatalogSyncSuggestions, validateCatalogSyncSelection,
  validateCatalogSyncModelProposal, catalogSyncGroupKey, proposedCatalogFor };
