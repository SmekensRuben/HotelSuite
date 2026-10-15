const test = require("node:test"), assert = require("node:assert/strict");
const { extractCatalogPhysicalIdentity, getCatalogSyncSuggestions, validateCatalogSyncSelection, validateCatalogSyncModelProposal, catalogSyncGroupKey } = require("./catalogSyncPolicy");
const offer = (supplierProductName, patch = {}) => ({ supplierProductName, baseUnit: "g", baseUnitsPerPurchaseUnit: 2400, catalogProductId: null, ...patch });
const catalog = (name, patch = {}) => ({ id: "catalog-one", name, baseUnit: "kg", active: true, brand: "", description: "", notes: "", allergens: [], ...patch });
const verdict = (name, target, patch = {}) => validateCatalogSyncSelection(offer(name, patch), catalog(target));
test("explicit supplier brands work without appearing in the name and respect catalog brand requirements", () => {
  const source = offer("Mozzarella sliced 400g", { brand: "Local Dairy" });
  assert.equal(validateCatalogSyncSelection(source, catalog("Mozzarella sliced", { brand: "Local Dairy" })).allowed, true);
  assert.equal(validateCatalogSyncSelection(source, catalog("Mozzarella sliced", { brand: "Other Dairy" })).allowed, false);
  assert.notEqual(catalogSyncGroupKey(source), catalogSyncGroupKey({ ...source, brand: "Other Dairy" }));
});

test("a same-brand physical article can share catalog identity across different supplier boxes and exact units", () => {
  const first = offer("Galbani Mozzarella sliced 6x400g"), second = offer("Galbani Mozzarella slices 12x400g", { baseUnitsPerPurchaseUnit: 4800 });
  const target = catalog("Mozzarella sliced", { brand: "Galbani" });
  const result = getCatalogSyncSuggestions(first, [target]);
  assert.equal(result.status, "suggested"); assert.equal(result.candidates[0].catalogProductId, target.id);
  assert.equal(result.candidates[0].matchKind, "physical-identity"); assert.equal(result.candidates[0].warnings.length, 0);
  assert.equal(validateCatalogSyncSelection(first, target).allowed, true);
  assert.equal(catalogSyncGroupKey(first), catalogSyncGroupKey(second));
  assert.equal(result.proposedCatalog.baseUnit, "kg");
});
test("sliced, whole, buffalo and different-brand mozzarella remain different physical articles", () => {
  const cases = [
    ["Galbani Mozzarella sliced 400g", catalog("Galbani Mozzarella whole 400g")],
    ["Galbani Mozzarella buffalo sliced 400g", catalog("Galbani Mozzarella cow sliced 400g")],
    ["Galbani Mozzarella sliced 400g", catalog("Zanetti Mozzarella sliced 400g")],
    ["Galbani Mozzarella fresh 400g", catalog("Galbani Mozzarella frozen 400g")],
  ];
  for (const [name, target] of cases) {
    const source = offer(name), result = validateCatalogSyncSelection(source, target);
    assert.equal(result.allowed, false, name + " / " + target.name); assert.ok(result.reasons.length > 0);
    assert.equal(getCatalogSyncSuggestions(source, [target]).candidates.length, 0);
    assert.notEqual(catalogSyncGroupKey(source), catalogSyncGroupKey({ ...source, supplierProductName: target.name }));
  }
});
test("diet, allergens, plant source and organic declarations cannot be overridden by similar names", () => {
  const cases = [
    [offer("Barilla gluten-free pasta"), catalog("Barilla regular wheat pasta")],
    [offer("Campina lactose-free milk", { baseUnit: "ml", baseUnitsPerPurchaseUnit: 1000 }), catalog("Campina regular milk", { baseUnit: "l" })],
    [offer("Campina vegan plant-based milk", { baseUnit: "ml", baseUnitsPerPurchaseUnit: 1000 }), catalog("Campina cow milk", { baseUnit: "l" })],
    [offer("Heinz organic tomato ketchup"), catalog("Heinz conventional tomato ketchup")],
    [offer("Galbani Mozzarella", { allergens: ["Milk"] }), catalog("Galbani Mozzarella", { allergens: ["Soy"] })],
    [offer("Campina soy milk", { baseUnit: "ml", baseUnitsPerPurchaseUnit: 1000 }), catalog("Campina oat milk", { baseUnit: "l" })],
  ];
  for (const [source, target] of cases) {
    assert.equal(validateCatalogSyncSelection(source, target).allowed, false, source.supplierProductName + " / " + target.name);
    assert.equal(validateCatalogSyncModelProposal(source, { catalogProductId: target.id, confidence: 1, override: true }, [target]).allowed, false);
  }
});
test("an unspecified important attribute or unknown brand requires review instead of claiming equivalence", () => {
  const source = offer("Mozzarella sliced 400g"), target = catalog("Mozzarella sliced");
  const result = getCatalogSyncSuggestions(source, [target]);
  assert.equal(result.status, "review"); assert.equal(result.candidates[0].status, "review");
  assert.match(result.candidates[0].warnings.join(" "), /brand.*not established/);
  assert.equal(catalogSyncGroupKey(source), null);
  const unspecified = getCatalogSyncSuggestions(offer("Galbani Mozzarella buffalo 400g"), [catalog("Galbani Mozzarella")]);
  assert.equal(unspecified.status, "review"); assert.match(unspecified.candidates[0].warnings.join(" "), /milk or animal source/);
});
test("cola variants and explicit alcohol strengths remain separate even under identical brands", () => {
  const liquid = { baseUnit: "ml", baseUnitsPerPurchaseUnit: 6000 }, target = { baseUnit: "l" };
  for (const [name, other] of [["Coca-Cola Zero 330ml", "Coca-Cola Original 330ml"], ["Coca-Cola Zero 330ml", "Coca-Cola Diet 330ml"],
    ["Pepsi Max 330ml", "Pepsi Classic 330ml"], ["Heineken beer 0.0 330ml", "Heineken beer 5% 330ml"], ["Leffe beer 6.6% 330ml", "Leffe beer 8.5% 330ml"]]) {
    assert.equal(validateCatalogSyncSelection(offer(name, liquid), catalog(other, target)).allowed, false, name + " / " + other);
  }
});
test("one counted bottle has its own specification and case quantities cannot conceal a different item size", () => {
  const source = offer("Spa Water 6x750ml", { baseUnit: "each", baseUnitsPerPurchaseUnit: 6 });
  const same = catalog("Spa Water 750ml", { baseUnit: "each" }), different = catalog("Spa Water 1L", { baseUnit: "each" });
  assert.equal(validateCatalogSyncSelection(source, same).allowed, true); assert.equal(getCatalogSyncSuggestions(source, [same]).status, "suggested");
  assert.equal(validateCatalogSyncSelection(source, different).allowed, false);
  assert.equal(catalogSyncGroupKey(source), catalogSyncGroupKey({ ...source, supplierProductName: "Spa Water 12x750ml", baseUnitsPerPurchaseUnit: 12 }));
  assert.notEqual(catalogSyncGroupKey(source), catalogSyncGroupKey({ ...source, supplierProductName: "Spa Water 6x1L" }));
  const unknown = getCatalogSyncSuggestions(offer("Spa Water bottles", { baseUnit: "each", baseUnitsPerPurchaseUnit: 6 }), [catalog("Spa Water bottles", { baseUnit: "each" })]);
  assert.equal(unknown.status, "review"); assert.equal(unknown.groupKey, null);
});
test("mass, volume and count incompatibilities are hard stops without density or guessed item weight", () => {
  const source = offer("Heinz Tomato ketchup 1kg", { baseUnit: "g", baseUnitsPerPurchaseUnit: 1000 });
  for (const baseUnit of ["l", "each", "invalid"]) {
    const target = catalog("Heinz Tomato ketchup 1kg", { baseUnit });
    assert.equal(validateCatalogSyncSelection(source, target).allowed, false);
    assert.equal(validateCatalogSyncModelProposal(source, { catalogProductId: target.id, confidence: 100 }, [target]).allowed, false);
  }
  assert.equal(getCatalogSyncSuggestions(offer("Unknown item", { baseUnit: null }), []).status, "needs-unit-review");
  assert.equal(getCatalogSyncSuggestions(offer("Heinz Ketchup", { baseUnitsPerPurchaseUnit: null }), []).status, "needs-unit-review");
  assert.equal(getCatalogSyncSuggestions(offer("Heinz Ketchup", { baseUnitsPerPurchaseUnit: 0 }), []).status, "needs-unit-review");
});
test("package GTIN agreement never overrules physical units, qualifiers or incomplete identity", () => {
  const gtin = "6291041500213", source = offer("Galbani Mozzarella sliced 400g", { gtin });
  const wrong = catalog("Galbani Mozzarella whole 400g", { gtin });
  assert.equal(validateCatalogSyncSelection(source, wrong).allowed, false);
  const possible = getCatalogSyncSuggestions(offer("Mozzarella sliced 400g", { gtin }), [catalog("Mozzarella sliced", { gtin })]);
  assert.equal(possible.status, "review"); assert.match(possible.candidates[0].warnings.join(" "), /barcode.*not proof/);
});
test("new proposals retain reviewable source names and never invent brand, taxonomy, allergens or copied box GTIN", () => {
  const result = getCatalogSyncSuggestions(offer("Unfamiliar supplier flour 12x500g", { gtin: "6291041500213" }), []);
  assert.equal(result.status, "new"); assert.deepEqual(result.proposedCatalog, { name: "Unfamiliar supplier flour 12x500g", baseUnit: "kg" });
  assert.equal(result.groupKey, null); assert.equal(result.proposedCatalog.brand, undefined); assert.equal(result.proposedCatalog.allergens, undefined); assert.equal(result.proposedCatalog.gtin, undefined);
});
test("different concentrations, oil grades and whole or ground forms remain distinct", () => {
  for (const [name, other] of [["Heinz tomato concentrate 30%", "Heinz tomato concentrate 15%"], ["Heinz concentrated tomato sauce", "Heinz ready-to-use tomato sauce"],
    ["Mutti extra virgin olive oil", "Mutti refined olive oil"], ["Rochefort whole pepper", "Rochefort ground pepper"]]) {
    assert.equal(verdict(name, other).allowed, false, name + " / " + other);
  }
});
test("scoped model candidates, deterministic ordering, bounded output and inactive or linked items are enforced", () => {
  const source = offer("Galbani Mozzarella sliced 400g"), pool = Array.from({ length: 8 }, (_, index) => catalog("Galbani Mozzarella sliced", { id: `p-${index}` }));
  const first = getCatalogSyncSuggestions(source, pool), reversed = getCatalogSyncSuggestions(source, [...pool].reverse());
  assert.equal(first.candidates.length, 5); assert.deepEqual(first, reversed);
  assert.equal(validateCatalogSyncModelProposal(source, { catalogProductId: "outside-hotel" }, pool).allowed, false);
  assert.equal(validateCatalogSyncModelProposal(source, { catalogProductId: "p-0", confidence: 1 }, pool).allowed, true);
  assert.equal(validateCatalogSyncSelection(source, catalog("Galbani Mozzarella sliced", { active: false })).allowed, false);
  assert.equal(getCatalogSyncSuggestions({ ...source, catalogProductId: "already-linked" }, pool).candidates.length, 0);
  assert.throws(() => getCatalogSyncSuggestions(source, Array(501).fill(pool[0])), RangeError);
  assert.throws(() => getCatalogSyncSuggestions(source, pool, { limit: 6 }), RangeError);
});
test("Dutch physical qualifiers and exact measures are extracted without inventing a brand", () => {
  const data = extractCatalogPhysicalIdentity(offer("MOZZARELLA PLAKKEN 400G diepvries"));
  assert.equal(data.brand, null); assert.deepEqual(data.qualifiers.form, ["sliced"]); assert.deepEqual(data.qualifiers.state, ["frozen"]);
  assert.deepEqual(data.coreTokens, ["mozzarella"]);
  const each = extractCatalogPhysicalIdentity(offer("Spa Water 6x75cl", { baseUnit: "each", baseUnitsPerPurchaseUnit: 6 }));
  assert.deepEqual(each.eachSpec, { unit: "l", quantity: 0.75, dimension: "volume" });
});
test("ambiguous thousands and unrepresentable per-item measures remain unknown rather than proving each equivalence", () => {
  for (const name of ["Spa Water 1,000ml", "Spa Water 1.000L", "Spa Water 750ml / 1L", "Galbani cheese 0.333333g"]) {
    const source = offer(name, { baseUnit: "each", baseUnitsPerPurchaseUnit: 6 }), physical = extractCatalogPhysicalIdentity(source);
    assert.equal(physical.eachSpecUnknown, true); assert.equal(physical.eachSpec, null); assert.equal(catalogSyncGroupKey(source), null);
  }
});
test("explicit product kinds, coffee forms, bones, dairy flavours and carbonation cannot be manually conflated", () => {
  const cases = [
    ["Heinz tomato ketchup", "Heinz tomato puree"], ["Heinz tomato ketchup", "Heinz tomato soup"],
    ["Rochefort coffee beans", "Rochefort ground coffee"], ["Rochefort boneless chicken fillet", "Rochefort bone-in chicken fillet"],
    ["Campina plain yogurt", "Campina strawberry yogurt"], ["Campina strawberry yogurt", "Campina vanilla yogurt"],
    ["Spa still water", "Spa sparkling water"],
  ];
  for (const [name, other] of cases) {
    const source = offer(name), target = catalog(other);
    assert.equal(validateCatalogSyncSelection(source, target).allowed, false, name + " / " + other);
    assert.equal(validateCatalogSyncModelProposal(source, { catalogProductId: target.id, override: true }, [target]).allowed, false);
    assert.equal(getCatalogSyncSuggestions(source, [target]).candidates.length, 0);
  }
  const unknown = getCatalogSyncSuggestions(offer("Heinz tomato"), [catalog("Heinz tomato ketchup")]);
  assert.equal(unknown.status, "review"); assert.match(unknown.candidates[0].warnings.join(" "), /productKind.*not established/);
});
test("financial percentages in notes and pricing descriptions cannot become physical concentration facts", () => {
  const source = offer("Heinz ketchup", { notes: "20% discount; VAT 21%; staff promo", description: "Save 15% off the invoice" });
  const target = catalog("Heinz ketchup");
  const facts = extractCatalogPhysicalIdentity(source); assert.deepEqual(facts.qualifiers.concentration, []);
  assert.equal(validateCatalogSyncSelection(source, target).allowed, true);
  assert.equal(getCatalogSyncSuggestions(source, [target]).status, "review");
  const physical = extractCatalogPhysicalIdentity(offer("Heinz tomato puree", { description: "Physical concentration: 30% tomato solids. Price discount: 20%." }));
  assert.deepEqual(physical.qualifiers.concentration, ["percent:30"]);
});
test("brand words with ordinary hotel meanings need a physical product context instead of becoming invented brands", () => {
  for (const name of ["Spa towels", "Lotus roots", "President office stationery"]) {
    assert.equal(extractCatalogPhysicalIdentity(offer(name)).brand, null); assert.equal(catalogSyncGroupKey(offer(name)), null);
  }
  assert.equal(extractCatalogPhysicalIdentity(offer("Spa Water 750ml")).brand, "spa");
  assert.equal(extractCatalogPhysicalIdentity(offer("Lotus Biscoff cookies 500g")).brand, "lotus");
});
test("explicit generic catalog peer review can allow different brands without relaxing any physical conflict", () => {
  const source = offer("Campina whole milk 1L", { baseUnit: "l", baseUnitsPerPurchaseUnit: 12 });
  const peer = offer("President whole milk 1L", { baseUnit: "l", baseUnitsPerPurchaseUnit: 6 });
  assert.equal(validateCatalogSyncSelection(source, peer).allowed, false);
  const explicitlyGeneric = validateCatalogSyncSelection(source, peer, { allowDifferentBrands: true });
  assert.equal(explicitlyGeneric.allowed, true); assert.match(explicitlyGeneric.warnings.join(" "), /brands differ.*generic catalog article.*explicitly reviewing/);
  assert.equal(validateCatalogSyncSelection(source, { ...peer, supplierProductName: "President skimmed milk 1L" }, { allowDifferentBrands: true }).allowed, false);
  assert.equal(validateCatalogSyncSelection(source, { ...peer, supplierProductName: "President whole milk 1L", baseUnit: "kg" }, { allowDifferentBrands: true }).allowed, false);
  const branded = catalog("President whole milk 1L", { brand: "President", baseUnit: "l" });
  assert.equal(validateCatalogSyncSelection(source, branded).allowed, false);
  assert.equal(validateCatalogSyncModelProposal(source, { catalogProductId: branded.id, allowDifferentBrands: true }, [branded]).allowed, false);
  assert.notEqual(catalogSyncGroupKey(source), catalogSyncGroupKey(peer));
});
test("translations and unknown synonyms need physical review while recognized different product kinds remain hard stops", () => {
  for (const [name, other] of [["Sinaasappelsap", "Orange juice"], ["Brood", "Bread"], ["Unknown source phrase", "Another unknown description"]]) {
    const source = offer(name), target = catalog(other), result = validateCatalogSyncSelection(source, target);
    expectReview(result, name + " / " + other);
    assert.equal(validateCatalogSyncModelProposal(source, { catalogProductId: target.id, confidence: 1 }, [target]).allowed, true);
  }
  for (const [name, other] of [["Milk", "Bread"], ["Orange juice", "Flour"], ["Coffee", "Tea"], ["Water", "Mozzarella cheese"], ["Milk chocolate", "Chocolate milk"]]) {
    assert.equal(validateCatalogSyncSelection(offer(name), catalog(other)).allowed, false, name + " / " + other);
  }
  const noWords = getCatalogSyncSuggestions(offer("Coca-Cola Zero", { baseUnit: "l", baseUnitsPerPurchaseUnit: 12 }), [catalog("Coca-Cola Zero", { baseUnit: "l" })]);
  assert.equal(noWords.status, "review"); assert.equal(noWords.candidates[0].status, "review"); assert.equal(noWords.physicalIdentity.coreTokens.length, 0);
});
function expectReview(result, context) {
  assert.equal(result.allowed, true, context); assert.ok(result.warnings.length, context);
}
