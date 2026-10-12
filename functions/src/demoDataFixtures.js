const { admin } = require("./config");
const { digest } = require("./validation");
const products = require("./productPolicy");
const receiving = require("./orderReceivingPolicy");
const inventory = require("./inventoryPolicy");
const { receiptInventoryLines } = require("./orderReceiving");
const { checkpointId } = require("./inventoryMovements");
const { DATASET_ID, PREFIX, TEST_HOTEL_UID, SUPPLIER_IDS } = require("./demoDataPolicy");

// This is a bounded, explicitly synthetic historical dataset, not a migration
// or a claim that these deliveries/counts occurred at the real hotel.
function buildDemoData({ actorUid, businessDate, currency, approvers = [] }) {
  inventory.businessDate(businessDate); inventory.currency(currency);
  const docs = [], hotelUid = TEST_HOTEL_UID;
  const meta = { datasetId: DATASET_ID, synthetic: true };
  const stamp = () => admin.firestore.FieldValue.serverTimestamp();
  const add = (path, data) => { docs.push({ path: `hotels/${hotelUid}/${path}`, data: { ...data, demoData: meta } }); return data; };
  const dated = (offset) => {
    const date = new Date(`${businessDate}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  };
  const at = (date) => admin.firestore.Timestamp.fromDate(new Date(`${date}T12:00:00Z`));
  const entity = (data) => ({ ...data, revision: 1, createdBy: actorUid, createdAt: stamp(), updatedBy: actorUid, updatedAt: stamp() });
  const catalogRows = [
    ["milk", "Whole milk", "l", "Dairy", ["Milk"]], ["butter", "Butter", "kg", "Dairy", ["Milk"]],
    ["flour", "Wheat flour", "kg", "Pantry", ["Gluten"]], ["rice", "Long grain rice", "kg", "Pantry", []],
    ["coffee", "Coffee beans", "g", "Beverages", []], ["oil", "Olive oil", "ml", "Pantry", []],
    ["eggs", "Eggs", "each", "Breakfast", ["Eggs"]], ["water", "Still water bottle 500 ml", "each", "Beverages", []],
    ["juice", "Orange juice", "l", "Beverages", []], ["soap", "Hand soap", "ml", "Housekeeping", []],
    ["napkins", "Paper napkins", "each", "Consumables", []], ["delivery", "Delivery service", "each", "Services", []],
  ];
  const catalogs = new Map(catalogRows.map(([key, name, baseUnit, category, allergens]) => {
    const id = `${PREFIX}catalog-${key}`;
    const data = entity(products.normalizeCatalogProduct({ name: `DEMO · ${name}`, baseUnit, category, allergens,
      active: true, inventoryTracked: key !== "delivery", notes: "Fictional test data. Do not use for financial reporting." }));
    add(`catalogproducts/${id}`, data); return [key, { id, ...data }];
  }));
  const names = ["DEMO · Fresh Foods", "DEMO · Pantry Supplies", "DEMO · Drinks & Essentials"];
  SUPPLIER_IDS.forEach((id, i) => add(`suppliers/${id}`, entity({ name: names[i], accountNumber: `DEMO-${i + 1}`,
    orderSystem: "Email", orderEmail: `orders-${i + 1}@supplier.example.invalid`, orderEmailCc: [], deliveryDays: [0, 1, 2, 3, 4, 5, 6],
    phone: "", category: "Demo suppliers", subcategory: "", webshopUrl: "", credentialsConfigured: false,
    notes: "Fictional supplier. All orders are simulated; no email or SFTP delivery." })));
  const offers = new Map();
  const offer = (key, catalogKey, supplierIndex, baseUnit, content, price, purchaseUnit, extras = {}) => {
    const id = `${PREFIX}offer-${key}`, supplierId = SUPPLIER_IDS[supplierIndex], catalog = catalogKey ? catalogs.get(catalogKey) : null;
    const data = entity(products.normalizeSupplierProduct({ supplierId, supplierSku: `DEMO-${key.toUpperCase()}`,
      supplierProductName: `DEMO · ${catalog ? catalog.name.replace("DEMO · ", "") : "Unlinked beverage"} · ${purchaseUnit}`,
      currency, pricingModel: "Per Purchase Unit", purchaseUnit, baseUnit, baseUnitsPerPurchaseUnit: content,
      pricePerPurchaseUnit: price, priceBasis: "net", vatRate: null, catalogProductId: catalog?.id ?? null, active: true, ...extras }));
    data.supplierName = names[supplierIndex];
    add(`supplierproducts/${id}`, data);
    add(`productSkuKeys/${digest(supplierId, data.supplierSku)}`, { productId: id, supplierId, supplierSku: data.supplierSku });
    offers.set(key, { id, ...data });
  };
  offer("milk-case", "milk", 0, "ml", 6000, 18, "Case of 6 x 1 l", { purchaseOptions: [{ id: "single", purchaseUnit: "Single 1 l", baseUnitsPerPurchaseUnit: 1000, pricePerPurchaseUnit: 3.5 }] });
  offer("milk-alternative", "milk", 1, "l", 12, 30, "Case of 12 x 1 l");
  offer("butter", "butter", 0, "g", 2500, 20, "10 x 250 g");
  offer("flour", "flour", 1, "g", 25000, 25, "25 kg sack"); offer("rice", "rice", 1, "kg", 5, 12.5, "5 kg bag");
  offer("coffee", "coffee", 1, "kg", 1, 18, "1 kg bag"); offer("oil", "oil", 1, "l", 5, 35, "5 l tin");
  offer("eggs", "eggs", 0, "each", 30, 9, "Tray of 30");
  offer("water", "water", 2, "each", 12, 6, "Case of 12", { purchaseOptions: [{ id: "single", purchaseUnit: "Single bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 0.65 }] });
  offer("juice", "juice", 2, "ml", 6000, 15.9, "6 x 1 l", { priceBasis: "gross", vatRate: 0.06 });
  offer("soap", "soap", 2, "l", 5, 10, "5 l refill"); offer("napkins", "napkins", 2, "each", 500, 8, "Pack of 500");
  offer("free-sample", "coffee", 1, "g", 100, 0, "100 g sample");
  offer("price-needed", "flour", 1, "kg", 1, null, "1 kg bag (price missing)");
  offer("unlinked", null, 2, "each", 6, 12, "Unlinked case of 6", { priceBasis: "unknown" });
  const outlets = ["Kitchen", "Lobby Bar", "Housekeeping"].map((name, i) => {
    const id = `${PREFIX}outlet-${i + 1}`; add(`outlets/${id}`, { name: `DEMO · ${name}` });
    for (const person of approvers) add(`outlets/${id}/approvers/${person.uid}`, { email: person.email, displayName: person.name, updatedAt: stamp(), updatedBy: actorUid });
    for (const [j, supplierId] of SUPPLIER_IDS.entries()) add(`supplierOutletAccounts/${digest(supplierId, id)}`, {
      supplierId, outletId: id, supplierName: names[j], outletName: `DEMO · ${name}`, accountNumber: `DEMO-${j + 1}`, updatedAt: stamp(), updatedBy: actorUid });
    return { id, name: `DEMO · ${name}` };
  });
  const locationSpecs = [
    ["Kitchen store", ["milk", "butter", "flour", "rice", "coffee", "oil", "eggs"], [100, 5, 20, 10, 1000, 2000, 60], [80, 4, 17, 8, 750, 1750, 45], [2, 8, 1, 2.5, 0.018, 0.007, 0.3]],
    ["Bar store", ["water", "juice"], [48, 12], [36, 8], [0.5, null]],
    ["Housekeeping store", ["soap", "napkins"], [5000, 1000], [4000, 750], [0.002, 0.016]],
  ];
  const locations = locationSpecs.map(([name, keys, opening, closing, costs], i) => {
    const id = `${PREFIX}location-${i + 1}`, templateId = `${PREFIX}template-${i + 1}`;
    const items = keys.map((key) => { const c = catalogs.get(key); return { catalogProductId: c.id, catalogProductName: c.name,
      baseUnit: c.baseUnit, inventoryPolicyVersion: 1, currency, unitCost: null }; });
    add(`locations/${id}`, { name: `DEMO · ${name}` });
    add(`locations/${id}/stockTemplates/${templateId}`, entity({ id: templateId, name: `DEMO · ${name} template`,
      inventoryPolicyVersion: 1, items: items.map(({ catalogProductId }) => ({ catalogProductId })) }));
    return { id, name: `DEMO · ${name}`, templateId, items, opening, closing, costs, sequence: 0 };
  });
  const count = (kind, date, finished) => {
    const id = `${PREFIX}count-${kind}`, summaries = [];
    for (const loc of locations) {
      const values = loc.items.map((item, i) => ({ ...item, quantity: kind === "opening" ? loc.opening[i] : loc.closing[i],
        unitCost: loc.costs[i], isCounted: true, countedBy: actorUid, countedAt: at(date),
        totalValue: loc.costs[i] === null ? null : inventory.money((kind === "opening" ? loc.opening[i] : loc.closing[i]) * loc.costs[i]) }));
      const items = finished ? values : values.slice(0, 1);
      const valuation = inventory.valuation(items);
      const checkpoint = finished ? checkpointId(id, loc.id) : null;
      const started = loc.sequence;
      if (finished) {
        inventory.completeCount(loc.items, items); loc.sequence++;
        add(`inventoryCheckpoints/${checkpoint}`, { id: checkpoint, inventoryPolicyVersion: 1, hotelUid, locationId: loc.id,
          stockCountId: id, stockCountName: `DEMO · ${kind} count`, businessDate: date, currency, sequence: loc.sequence,
          items: values.map(({ catalogProductId, catalogProductName, baseUnit, quantity, unitCost }) => ({ catalogProductId, catalogProductName, baseUnit, quantity, unitCost })),
          coverageIssues: [], actorUid, finishedAt: at(date) });
      }
      const summary = { locationId: loc.id, locationName: loc.name, stockTemplateId: loc.templateId, stockTemplateName: `${loc.name} template`,
        status: finished ? "Finished" : "In Progress", inventoryPolicyVersion: 1, currency, ...valuation,
        checkpointId: checkpoint, checkpointSequence: finished ? loc.sequence : null };
      summaries.push(summary);
      add(`stockCounts/${id}/locations/${loc.id}`, { id: loc.id, ...summary, businessDate: date, countingStartedSequence: started,
        stockTemplate: { id: loc.templateId, name: summary.stockTemplateName, items: loc.items }, countedItems: items,
        revision: finished ? 1 : 0, createdAt: at(date), createdBy: actorUid, ...(finished ? { finishedAt: at(date), finishedBy: actorUid } : {}) });
    }
    add(`stockCounts/${id}`, { id, name: `DEMO · ${kind} count`, type: "Weekly", status: finished ? "Finished" : "Started",
      inventoryPolicyVersion: 1, currency, businessDate: date, revision: finished ? 2 : 0, locations: summaries,
      countedValue: summaries.every((s) => s.countedValue != null) ? inventory.money(summaries.reduce((s, l) => s + l.countedValue, 0)) : null,
      creationFingerprint: digest(DATASET_ID, kind), createdBy: actorUid, createdAt: at(date), ...(finished ? { finishedAt: at(date), finishedBy: actorUid } : {}) });
    return id;
  };
  const openingId = count("opening", dated(-10), true);
  const orders = new Map();
  const order = (key, offerKeys, quantities, outletIndex, status = "Created", options = []) => {
    const id = `${PREFIX}order-${key}`, outlet = outlets[outletIndex];
    const lines = offerKeys.map((offerKey, i) => {
      const source = offers.get(offerKey), option = products.resolvePurchaseOption(source, options[i] ?? "default");
      const catalog = [...catalogs.values()].find((row) => row.id === source.catalogProductId) ?? null;
      return { supplierProductId: source.id, supplierId: source.supplierId, supplierSku: source.supplierSku, supplierProductName: source.supplierProductName,
        supplierName: source.supplierName, outletId: outlet.id, outletName: outlet.name, qtyPurchaseUnits: quantities[i], note: "Fictional test line",
        purchaseOptionId: option.id, orderLineId: `l-${digest(source.id, option.id).slice(0, 40)}`, purchaseUnit: option.purchaseUnit,
        baseUnit: option.baseUnit, baseUnitsPerPurchaseUnit: option.baseUnitsPerPurchaseUnit, pricePerPurchaseUnit: option.pricePerPurchaseUnit,
        currency: option.currency, priceBasis: option.priceBasis, vatRate: option.vatRate, netPricePerPurchaseUnit: option.netPricePerPurchaseUnit,
        inventoryTerms: products.inventoryTerms(source, catalog, option) };
    });
    const { orderPriceContract } = require("./orders"), contract = orderPriceContract(lines);
    const row = { id, supplierId: lines[0].supplierId, supplierName: lines[0].supplierName, outletId: outlet.id, outletName: outlet.name,
      accountNumber: `DEMO-${SUPPLIER_IDS.indexOf(lines[0].supplierId) + 1}`, products: lines, ...contract,
      totalAmount: Math.round(lines.reduce((sum, line) => sum + line.pricePerPurchaseUnit * line.qtyPurchaseUnits, 0) * 100) / 100,
      deliveryDate: dated(-5), status, revision: 1, dispatchMode: "simulation", dispatchStatus: status === "Ordered" ? "sent" : "",
      createdBy: actorUid, createdAt: at(dated(-6)), updatedBy: actorUid, updatedAt: at(dated(-6)) };
    orders.set(key, { id, row }); return row;
  };
  order("draft-breakfast", ["milk-case", "eggs"], [2, 1], 0, "Created", ["single", "default"]);
  order("draft-pantry", ["flour", "rice", "coffee", "free-sample"], [1, 2, 3, 1], 0);
  order("awaiting", ["soap", "napkins"], [2, 2], 2, "Ordered");
  order("milk-received", ["milk-case"], [5], 0, "Ordered");
  order("water-partial", ["water"], [3], 1, "Ordered");
  order("gross-juice", ["juice"], [2], 1);
  order("canceled", ["rice"], [1], 0, "Canceled");
  const receipt = (key, suffix, accepted, rejected, locIndex) => {
    const { id: orderId, row } = orders.get(key), id = `${PREFIX}receipt-${suffix}`, loc = locations[locIndex];
    const details = receiving.normalizeReceipt({ receivedOn: dated(-5), deliveryReference: `DEMO-${suffix}`, note: "Simulated delivery; no supplier contacted.",
      lines: row.products.map((p) => ({ supplierProductId: p.supplierProductId, orderLineId: p.orderLineId,
        acceptedQuantity: accepted, rejectedQuantity: rejected, reason: rejected ? "DEMO damaged packaging" : "" })) });
    row.receiving = receiving.applyReceipt(receiving.receivingState(row), details);
    row.status = row.receiving.state === "complete" ? "Received" : "Ordered"; row.revision++;
    const converted = receiptInventoryLines(row.products, details.lines), sequence = ++loc.sequence;
    const movement = { id, inventoryPolicyVersion: 1, kind: "receipt", hotelUid, locationId: loc.id, orderId, receiptId: id,
      receivedOn: details.receivedOn, sequence, actorUid, ...converted, backdatedAgainstCheckpoint: false, postedAt: at(details.receivedOn) };
    add(`inventoryMovements/${id}`, movement);
    const result = { hotelUid, orderId, eventId: id, status: row.status, revision: row.revision, receivingState: row.receiving.state };
    const event = { policyVersion: 1, kind: "receipt", hotelUid, orderId, actorUid, actorName: "DEMO seed", ...details,
      lines: details.lines.map((line) => { const source = row.products.find((p) => p.orderLineId === line.orderLineId); return { ...line, productName: source.supplierProductName, purchaseUnit: source.purchaseUnit }; }),
      inventoryLocationId: loc.id, inventoryMovement: { movementId: id, locationId: loc.id, sequence, inventoryPolicyVersion: 1 }, result,
      fingerprint: digest(DATASET_ID, suffix), revision: row.revision, createdAt: at(details.receivedOn) };
    add(`orders/${orderId}/receipts/${id}`, event);
    add(`orders/${orderId}/receiptReferences/${digest(details.deliveryReference.normalize("NFKC").replace(/\s+/g, " ").toLowerCase())}`, { eventId: id, createdAt: at(details.receivedOn) });
    add(`orderAudit/${id}`, { orderId, action: "receiving-receipt", eventId: id, actorUid, revision: row.revision, createdAt: at(details.receivedOn) });
    return { id, event, movement };
  };
  receipt("milk-received", "milk-complete", 5, 0, 0);
  receipt("water-partial", "water-first", 1, 0, 1);
  const reversed = receipt("water-partial", "water-damaged", 1, 1, 1);
  const water = orders.get("water-partial"), reversalId = `${PREFIX}receipt-water-reversal`, bar = locations[1];
  water.row.receiving = receiving.applyReversal(water.row.receiving, reversed.event); water.row.status = "Ordered"; water.row.revision++;
  const reversalSequence = ++bar.sequence;
  add(`inventoryMovements/${reversalId}`, { ...reversed.movement, id: reversalId, kind: "reversal", originalMovementId: reversed.id,
    receiptId: reversalId, sequence: reversalSequence, lines: reversed.movement.lines.map((line) => ({ ...line, quantity: -line.quantity, netValue: -line.netValue })) });
  add(`inventoryReversals/${reversed.id}`, { movementId: reversalId, postedAt: at(dated(-5)) });
  const reversalResult = { hotelUid, orderId: water.id, eventId: reversalId, status: "Ordered", revision: water.row.revision, receivingState: "partial" };
  add(`orders/${water.id}/receipts/${reversalId}`, { policyVersion: 1, kind: "reversal", hotelUid, orderId: water.id, actorUid, actorName: "DEMO seed",
    receiptId: reversed.id, reason: "DEMO reversal of incorrect delivery entry", fingerprint: digest(DATASET_ID, reversalId), revision: water.row.revision,
    result: reversalResult, inventoryMovement: { movementId: reversalId, locationId: bar.id, sequence: reversalSequence, inventoryPolicyVersion: 1 }, createdAt: at(dated(-5)) });
  add(`orders/${water.id}/receiptReversals/${reversed.id}`, { eventId: reversalId, actorUid, reason: "DEMO reversal", createdAt: at(dated(-5)) });
  add(`orderAudit/${reversalId}`, { orderId: water.id, action: "receiving-reversal", eventId: reversalId, actorUid, revision: water.row.revision, createdAt: at(dated(-5)) });
  const closingId = count("closing", dated(-1), true);
  count("in-progress", businessDate, false);
  for (const loc of locations) add(`inventoryLocationStates/${loc.id}`, { inventoryPolicyVersion: 1, sequence: loc.sequence,
    latestCheckpointId: checkpointId(closingId, loc.id), latestCheckpointBusinessDate: dated(-1), updatedAt: stamp() });
  for (const { id, row } of orders.values()) { if (row.receiving) receiving.receivingState(row); add(`orders/${id}`, row); }
  return { docs, summary: { catalogProducts: catalogs.size, supplierProducts: offers.size, suppliers: SUPPLIER_IDS.length,
    outlets: outlets.length, locations: locations.length, stockTemplates: locations.length, orders: orders.size,
    stockCounts: 3, receipts: 4, inventoryMovements: 4, approvers: approvers.length,
    openingStockCountId: openingId, closingStockCountId: closingId, periodLocationId: locations[0].id,
    milkCatalogProductId: catalogs.get("milk").id, expectedMilkUsage: 50 } };
}
module.exports = { buildDemoData };
