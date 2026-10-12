const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireHotelPermission } = require("./authorization");
const { requireDocumentId } = require("./subscriptions");
const { digest, text } = require("./validation");
const { gated, requireSaasRollout } = require("./saasRollout");
const { isArchived } = require("./procurementResources");
const inventory = require("./inventoryPolicy");
const policy = require("./inventoryAdjustmentPolicy");
const { stateRef, sequence } = require("./inventoryMovements");
const { validTimeZone } = require("./hotelSetupPolicy");
const { localDate } = require("./importMonitoringPolicy");
const { calculateNetValue } = require("./productPolicy");
const stamp = () => admin.firestore.FieldValue.serverTimestamp();
const adjustmentRef = (db, hotelUid, id) => db.doc(`hotels/${hotelUid}/inventoryAdjustments/${id}`);
const reversalRef = (db, hotelUid, id) => db.doc(`hotels/${hotelUid}/inventoryAdjustmentReversals/${id}`);
const operationRef = (db, hotelUid, actorUid, requestId) => db.doc(`hotels/${hotelUid}/inventoryAdjustmentOperations/${digest(actorUid, requestId)}`);
const adjustmentId = (actorUid, hotelUid, requestId) => `a-${digest(actorUid, hotelUid, requestId).slice(0, 48)}`;
async function authorize(db, tx, request, hotelUid, action, services) {
  // Fresh request objects ensure current Auth is checked again on an actual retry.
  await requireHotelPermission(db, { ...request }, hotelUid, "inventorymovements", action, tx, services.auth);
  await requireSaasRollout(db, tx);
}
async function hotelSettings(db, tx, hotelUid) {
  const [hotel, bootstrap] = await Promise.all([tx.get(db.doc(`hotels/${hotelUid}`)), tx.get(db.doc(`hotels/${hotelUid}/settings/bootstrap`))]);
  if (!hotel.exists) throw new HttpsError("failed-precondition", "Hotel settings are unavailable.");
  const stored = bootstrap.exists ? bootstrap.data().currency : hotel.data().currency;
  const hotelCurrency = stored == null ? null : inventory.currency(stored);
  if (bootstrap.exists && hotel.data().currency != null && hotel.data().currency !== hotelCurrency) {
    throw new HttpsError("failed-precondition", "Hotel currency settings disagree. Reconcile them before recording a value.");
  }
  return { hotelCurrency, timeZone: hotel.data().timeZone };
}
function validateDate(date, settings, services) {
  const now = services.now?.() ?? Date.now();
  if (!validTimeZone(settings.timeZone)) throw new HttpsError("failed-precondition", "Set a valid hotel time zone before recording physical inventory adjustments.");
  const today = localDate(now, settings.timeZone);
  if (date > today) throw new HttpsError("invalid-argument", "A physical inventory adjustment cannot have a future business date.");
}
function uncommitted(error) {
  if (error instanceof HttpsError) throw new HttpsError(error.code, error.message, { inventoryAdjustmentRequestUncommitted: true });
  throw error;
}
function currentLocation(snapshot) {
  if (!snapshot.exists || isArchived(snapshot.data())) throw new HttpsError("failed-precondition", "Choose active physical locations in the selected hotel.");
  return text(snapshot.data().name, "Location name", 200, true);
}
function movement(db, hotelUid, id, source, locationId, kind, sign, state, actorUid, businessDate, originalMovementId = null) {
  const next = sequence(state) + 1;
  const value = { id, hotelUid, locationId, inventoryPolicyVersion: 1, inventoryAdjustmentPolicyVersion: 1,
    adjustmentId: source.adjustmentId, kind, originalMovementId, originalKind: originalMovementId ? source.originalKind : null,
    sequence: next, receivedOn: businessDate, businessDate, actorUid, postedAt: stamp(),
    backdatedAgainstCheckpoint: Boolean(state.data()?.latestCheckpointBusinessDate && businessDate <= state.data().latestCheckpointBusinessDate),
    coverageGaps: [], lines: [{ catalogProductId: source.catalogProductId, catalogProductName: source.catalogProductName,
      baseUnit: source.baseUnit, quantity: source.quantity * sign, netUnitCost: source.netUnitCost,
      netValue: source.netValue == null ? null : source.netValue * sign, currency: source.currency }] };
  return { value, write: (tx) => {
    tx.create(db.doc(`hotels/${hotelUid}/inventoryMovements/${id}`), value);
    tx.set(stateRef(db, hotelUid, locationId), { inventoryPolicyVersion: 1, sequence: next, updatedAt: stamp() }, { merge: true });
  } };
}
async function recordHotelInventoryAdjustmentHandler(request, services = {}) {
  const input = policy.record(request.data), { hotelUid } = input, db = services.firestore || admin.firestore();
  const id = adjustmentId(request.auth?.uid, hotelUid, input.requestId), fingerprint = digest("record", input);
  const operation = operationRef(db, hotelUid, request.auth?.uid, input.requestId), ref = adjustmentRef(db, hotelUid, id);
  return db.runTransaction(async (tx) => {
    await authorize(db, tx, request, hotelUid, "create", services);
    if (input.expectedActorUid !== request.auth.uid) throw new HttpsError("failed-precondition", "This pending inventory adjustment belongs to another signed-in user.");
    const previous = await tx.get(operation);
    if (previous.exists) {
      if (previous.data().fingerprint !== fingerprint) throw new HttpsError("already-exists", "This adjustment request ID was used for different details.");
      return previous.data().result;
    }
    try {
      const [settings, catalog, source, destination, sourceState, destinationState, existing] = await Promise.all([
        hotelSettings(db, tx, hotelUid), tx.get(db.doc(`hotels/${hotelUid}/catalogproducts/${input.catalogProductId}`)),
        tx.get(db.doc(`hotels/${hotelUid}/locations/${input.sourceLocationId}`)),
        input.destinationLocationId ? tx.get(db.doc(`hotels/${hotelUid}/locations/${input.destinationLocationId}`)) : null,
        tx.get(stateRef(db, hotelUid, input.sourceLocationId)),
        input.destinationLocationId ? tx.get(stateRef(db, hotelUid, input.destinationLocationId)) : null, tx.get(ref),
      ]);
      if (existing.exists) throw new HttpsError("failed-precondition", "Adjustment command evidence needs reconciliation.");
      validateDate(input.businessDate, settings, services);
      if (!catalog.exists || isArchived(catalog.data()) || catalog.data().inventoryTracked !== true) {
        throw new HttpsError("failed-precondition", "Choose an active, inventory-tracked catalog product in the selected hotel.");
      }
      if (input.currency != null && input.currency !== settings.hotelCurrency) throw new HttpsError("failed-precondition", "Adjustment currency must match the explicit hotel currency.");
      const summary = { ...input, id, adjustmentId: id, inventoryAdjustmentPolicyVersion: 1,
        catalogProductName: text(catalog.data().name, "Catalog product name", 200, true), baseUnit: inventory.unit(catalog.data().baseUnit),
        sourceLocationName: currentLocation(source), destinationLocationName: destination ? currentLocation(destination) : null,
        currency: input.netUnitCost == null ? null : settings.hotelCurrency, originalAdjustmentId: null,
        actorUid: request.auth.uid, postedAt: stamp(), postedAtMillis: services.now?.() ?? Date.now() };
      const sourceKind = input.kind === "transfer" ? "transfer_out" : input.kind === "waste" ? input.reasonType : "physical_return";
      const postings = [movement(db, hotelUid, `${id}-out`, summary, input.sourceLocationId, sourceKind, -1, sourceState, request.auth.uid, input.businessDate)];
      if (destination) postings.push(movement(db, hotelUid, `${id}-in`, summary, input.destinationLocationId, "transfer_in", 1, destinationState, request.auth.uid, input.businessDate));
      // Every read has completed before either transfer leg or shared state writes.
      const movementIds = postings.map((item) => item.value.id);
      const result = { hotelUid, actorUid: request.auth.uid, requestId: input.requestId, adjustmentId: id, kind: input.kind, businessDate: input.businessDate, movementIds, inventoryAdjustmentPolicyVersion: 1 };
      tx.create(ref, { ...summary, movementIds });
      for (const posting of postings) posting.write(tx);
      tx.create(operation, { fingerprint, result, actorUid: request.auth.uid, createdAt: stamp() });
      return result;
    } catch (error) { return uncommitted(error); }
  });
}
function validateOriginalSummary(summary, hotelUid, id) {
  try {
    if (summary?.inventoryAdjustmentPolicyVersion !== 1 || summary.hotelUid !== hotelUid || summary.id !== id || summary.adjustmentId !== id
      || !["transfer", "waste", "physical_return"].includes(summary.kind)) throw new Error("scope");
    inventory.unit(summary.baseUnit); inventory.businessDate(summary.businessDate);
    requireDocumentId(summary.catalogProductId, "Stored catalog product ID"); requireDocumentId(summary.sourceLocationId, "Stored source location ID");
    inventory.amount(summary.quantity, "Original adjustment quantity"); inventory.cost(summary.netUnitCost);
    if (summary.quantity <= 0 || summary.originalAdjustmentId != null || summary.kind === "waste" && !["waste", "breakage"].includes(summary.reasonType)
      || summary.kind !== "waste" && summary.reasonType != null
      || summary.netUnitCost == null && (summary.currency != null || summary.netValue != null)
      || summary.netUnitCost != null && (inventory.currency(summary.currency) !== summary.currency || calculateNetValue(summary.quantity, summary.netUnitCost) !== summary.netValue)) throw new Error("source contract");
    if (summary.kind === "transfer") {
      requireDocumentId(summary.destinationLocationId, "Stored destination location ID");
      if (summary.destinationLocationId === summary.sourceLocationId) throw new Error("transfer scope");
    } else if (summary.destinationLocationId != null) throw new Error("destination");
    if (!Array.isArray(summary.movementIds) || summary.movementIds.length !== (summary.kind === "transfer" ? 2 : 1)
      || new Set(summary.movementIds).size !== summary.movementIds.length) throw new Error("posting count");
  } catch { throw new HttpsError("failed-precondition", "Original adjustment source policy, quantity, value or scope needs reconciliation."); }
}
function validateOriginalLeg(doc, summary) {
  const value = doc.data();
  if (!doc.exists || value?.inventoryAdjustmentPolicyVersion !== 1 || value.inventoryPolicyVersion !== 1
    || value.id !== doc.id || value.hotelUid !== summary.hotelUid || value.adjustmentId !== summary.id || !policy.MANUAL_KINDS.has(value.kind)
    || value.receivedOn !== summary.businessDate || value.businessDate !== summary.businessDate || !summary.movementIds.includes(doc.id)
    || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !Array.isArray(value.lines) || value.lines.length !== 1) {
    throw new HttpsError("failed-precondition", "The original adjustment movement needs reconciliation.");
  }
  const line = value.lines[0], direction = value.kind === "transfer_in" ? 1 : -1;
  const expectedLocation = direction === 1 ? summary.destinationLocationId : summary.sourceLocationId;
  const expectedKind = summary.kind === "transfer" ? direction === 1 ? "transfer_in" : "transfer_out" : summary.kind === "waste" ? summary.reasonType : "physical_return";
  if (value.kind !== expectedKind || value.locationId !== expectedLocation || line.catalogProductId !== summary.catalogProductId || line.baseUnit !== summary.baseUnit
    || line.quantity !== summary.quantity * direction || line.netUnitCost !== summary.netUnitCost || line.currency !== summary.currency
    || line.netValue !== (summary.netValue == null ? null : summary.netValue * direction)) {
    throw new HttpsError("failed-precondition", "The original adjustment quantity, value or location needs reconciliation.");
  }
  return value;
}
async function reverseHotelInventoryAdjustmentHandler(request, services = {}) {
  const input = policy.reverse(request.data), { hotelUid } = input, db = services.firestore || admin.firestore();
  const id = adjustmentId(request.auth?.uid, hotelUid, input.requestId), fingerprint = digest("reverse", input);
  const operation = operationRef(db, hotelUid, request.auth?.uid, input.requestId), ref = adjustmentRef(db, hotelUid, id);
  return db.runTransaction(async (tx) => {
    await authorize(db, tx, request, hotelUid, "reverse", services);
    if (input.expectedActorUid !== request.auth.uid) throw new HttpsError("failed-precondition", "This pending inventory reversal belongs to another signed-in user.");
    const previous = await tx.get(operation);
    if (previous.exists) {
      if (previous.data().fingerprint !== fingerprint) throw new HttpsError("already-exists", "This adjustment request ID was used for different details.");
      return previous.data().result;
    }
    try {
      const [original, reversed, existing, settings] = await Promise.all([
        tx.get(adjustmentRef(db, hotelUid, input.adjustmentId)), tx.get(reversalRef(db, hotelUid, input.adjustmentId)), tx.get(ref), hotelSettings(db, tx, hotelUid),
      ]);
      if (!original.exists || original.data().inventoryAdjustmentPolicyVersion !== 1 || original.data().hotelUid !== hotelUid
        || original.data().id !== input.adjustmentId || !["transfer", "waste", "physical_return"].includes(original.data().kind)) {
        throw new HttpsError("failed-precondition", "Only an original manual inventory adjustment in this hotel can be reversed.");
      }
      if (reversed.exists) throw new HttpsError("already-exists", "This manual inventory adjustment has already been reversed.");
      if (existing.exists) throw new HttpsError("failed-precondition", "Reversal command evidence needs reconciliation.");
      validateDate(input.businessDate, settings, services);
      const source = original.data();
      validateOriginalSummary(source, hotelUid, input.adjustmentId);
      if (input.businessDate < source.businessDate) throw new HttpsError("invalid-argument", "A reversal cannot precede the original physical adjustment business date.");
      const originalDocs = await Promise.all(source.movementIds.map((movementId) => tx.get(db.doc(`hotels/${hotelUid}/inventoryMovements/${requireDocumentId(movementId, "Stored movement ID")}`))));
      const legs = originalDocs.map((doc) => validateOriginalLeg(doc, source));
      if (source.kind === "transfer" && (new Set(legs.map((leg) => leg.locationId)).size !== 2 || !legs.some((leg) => leg.kind === "transfer_in") || !legs.some((leg) => leg.kind === "transfer_out"))) {
        throw new HttpsError("failed-precondition", "A transfer reversal requires both balanced original legs.");
      }
      // Archived/renamed sources do not alter or block a frozen compensating entry.
      const states = await Promise.all(legs.map((leg) => tx.get(stateRef(db, hotelUid, requireDocumentId(leg.locationId, "Stored location ID")))));
      const summary = { ...source, id, adjustmentId: id, requestId: input.requestId, kind: "reversal", originalAdjustmentId: source.id,
        originalKind: source.kind, businessDate: input.businessDate, note: input.note, reference: input.reference,
        actorUid: request.auth.uid, postedAt: stamp(), postedAtMillis: services.now?.() ?? Date.now() };
      const postings = legs.map((leg, index) => movement(db, hotelUid, `${id}-${index}`, { ...summary, originalKind: leg.kind }, leg.locationId,
        "adjustment_reversal", leg.kind === "transfer_in" ? -1 : 1, states[index], request.auth.uid, input.businessDate, leg.id));
      const movementIds = postings.map((item) => item.value.id);
      const result = { hotelUid, actorUid: request.auth.uid, requestId: input.requestId, originalAdjustmentId: source.id, reversalAdjustmentId: id, movementIds, inventoryAdjustmentPolicyVersion: 1 };
      tx.create(ref, { ...summary, movementIds });
      for (const posting of postings) posting.write(tx);
      tx.create(reversalRef(db, hotelUid, source.id), { originalAdjustmentId: source.id, reversalAdjustmentId: id, actorUid: request.auth.uid, postedAt: stamp() });
      tx.create(operation, { fingerprint, result, actorUid: request.auth.uid, createdAt: stamp() });
      return result;
    } catch (error) { return uncommitted(error); }
  });
}
// A period may show just one transfer location, but it must still prove that
// the immutable opposite leg exists. Reversals prove both original legs too.
async function validateManualPeriodEvidence(db, tx, hotelUid, sources) {
  const snapshots = new Map();
  const adjustmentPath = (id) => `hotels/${hotelUid}/inventoryAdjustments/${requireDocumentId(id, "Stored adjustment ID")}`;
  const postingPath = (id) => `hotels/${hotelUid}/inventoryMovements/${requireDocumentId(id, "Stored movement ID")}`;
  const pointerPath = (id) => `hotels/${hotelUid}/inventoryAdjustmentReversals/${requireDocumentId(id, "Stored adjustment ID")}`;
  async function readMany(paths) {
    const needed = [...new Set(paths)].filter((path) => !snapshots.has(path));
    // Bounded concurrent batches avoid a serialized RPC chain for large periods.
    const batches = [];
    for (let index = 0; index < needed.length; index += 100) batches.push(needed.slice(index, index + 100));
    for (let offset = 0; offset < batches.length; offset += 10) {
      const group = batches.slice(offset, offset + 10);
      const results = await Promise.all(group.map((batch) => tx.getAll(...batch.map((path) => db.doc(path)))));
      for (let batch = 0; batch < group.length; batch++) for (let index = 0; index < group[batch].length; index++) snapshots.set(group[batch][index], results[batch][index]);
    }
  }
  const ids = [...new Set(sources.filter((source) => policy.MANUAL_KINDS.has(source.kind) || source.kind === "adjustment_reversal").map((source) => source.adjustmentId))];
  await readMany(ids.map(adjustmentPath));
  const summaries = ids.map((id) => snapshots.get(adjustmentPath(id)));
  for (const summaryDoc of summaries) {
    const summary = summaryDoc.data();
    if (!summaryDoc.exists || summary?.hotelUid !== hotelUid || summary.id !== summaryDoc.id || summary.inventoryAdjustmentPolicyVersion !== 1) {
      throw new HttpsError("failed-precondition", "Manual inventory command evidence needs reconciliation.");
    }
  }
  await readMany(summaries.filter((doc) => doc.data().kind === "reversal").flatMap((doc) => [adjustmentPath(doc.data().originalAdjustmentId), pointerPath(doc.data().originalAdjustmentId)]));
  const allLegPaths = [];
  for (const summaryDoc of summaries) {
    const summary = summaryDoc.data(), originalDoc = summary.kind === "reversal" ? snapshots.get(adjustmentPath(summary.originalAdjustmentId)) : summaryDoc;
    if (!originalDoc.exists) throw new HttpsError("failed-precondition", "The original manual command evidence is missing.");
    const original = originalDoc.data();
    validateOriginalSummary(original, hotelUid, originalDoc.id);
    allLegPaths.push(...original.movementIds.map(postingPath));
    if (summary.kind === "reversal") {
      if (!Array.isArray(summary.movementIds) || summary.movementIds.length !== original.movementIds.length) throw new HttpsError("failed-precondition", "Manual reversal posting evidence needs reconciliation.");
      allLegPaths.push(...summary.movementIds.map(postingPath));
    }
  }
  await readMany(allLegPaths);
  for (const summaryDoc of summaries) {
    const summary = summaryDoc.data(), originalDoc = summary.kind === "reversal" ? snapshots.get(adjustmentPath(summary.originalAdjustmentId)) : summaryDoc, original = originalDoc.data();
    const originals = original.movementIds.map((id) => snapshots.get(postingPath(id)));
    const originalLegs = originals.map((doc) => validateOriginalLeg(doc, original));
    if (original.kind === "transfer" && (new Set(originalLegs.map((leg) => leg.locationId)).size !== 2
      || !originalLegs.some((leg) => leg.kind === "transfer_in") || !originalLegs.some((leg) => leg.kind === "transfer_out"))) {
      throw new HttpsError("failed-precondition", "A transfer requires both balanced immutable source legs.");
    }
    let checkedLegs = originalLegs;
    if (summary.kind === "reversal") {
      const pointer = snapshots.get(pointerPath(original.id));
      const fields = ["catalogProductId", "baseUnit", "quantity", "netUnitCost", "netValue", "currency", "sourceLocationId", "destinationLocationId", "reasonType"];
      if (summary.adjustmentId !== summary.id || summary.originalKind !== original.kind || pointer.data()?.reversalAdjustmentId !== summary.id
        || fields.some((field) => summary[field] !== original[field]) || !Array.isArray(summary.movementIds)
        || summary.movementIds.length !== originalLegs.length || new Set(summary.movementIds).size !== summary.movementIds.length
        || inventory.businessDate(summary.businessDate) < original.businessDate) {
        throw new HttpsError("failed-precondition", "The manual compensating command needs reconciliation.");
      }
      const reversedDocs = summary.movementIds.map((id) => snapshots.get(postingPath(id)));
      const referenced = new Set();
      checkedLegs = reversedDocs.map((doc) => {
        const leg = doc.data(), originalLeg = originalLegs.find((item) => item.id === leg?.originalMovementId), line = leg?.lines?.[0], originalLine = originalLeg?.lines[0];
        if (!doc.exists || !originalLeg || referenced.has(originalLeg.id) || leg.id !== doc.id || leg.hotelUid !== hotelUid || leg.adjustmentId !== summary.id
          || leg.inventoryPolicyVersion !== 1 || leg.inventoryAdjustmentPolicyVersion !== 1 || leg.kind !== "adjustment_reversal" || leg.originalKind !== originalLeg.kind
          || leg.locationId !== originalLeg.locationId || leg.receivedOn !== summary.businessDate || leg.businessDate !== summary.businessDate
          || !Number.isSafeInteger(leg.sequence) || leg.sequence <= originalLeg.sequence || !Array.isArray(leg.lines) || leg.lines.length !== 1
          || line.catalogProductId !== originalLine.catalogProductId || line.baseUnit !== originalLine.baseUnit || line.quantity !== -originalLine.quantity
          || line.netUnitCost !== originalLine.netUnitCost || line.currency !== originalLine.currency || line.netValue !== (originalLine.netValue == null ? null : -originalLine.netValue)) {
          throw new HttpsError("failed-precondition", "A manual reversal does not exactly compensate its original posting.");
        }
        referenced.add(originalLeg.id); return leg;
      });
    }
    const relevant = sources.filter((item) => item.adjustmentId === summary.id);
    if (relevant.some((item) => !checkedLegs.some((leg) => leg.id === item.id))) throw new HttpsError("failed-precondition", "A period contains unproven manual postings.");
  }
}
function projection(snapshot, reversed) {
  const row = snapshot.data();
  if (row.inventoryAdjustmentPolicyVersion !== 1 || row.id !== snapshot.id || !Array.isArray(row.movementIds)
    || !Number.isSafeInteger(row.postedAtMillis)) throw new HttpsError("failed-precondition", "The stored inventory adjustment needs reconciliation.");
  const fields = ["kind", "reasonType", "originalKind", "originalAdjustmentId", "businessDate", "note", "reference", "catalogProductId", "catalogProductName", "baseUnit", "quantity", "netUnitCost", "netValue", "currency", "sourceLocationId", "sourceLocationName", "destinationLocationId", "destinationLocationName", "actorUid", "postedAtMillis", "movementIds"];
  return { id: snapshot.id, adjustmentId: snapshot.id, inventoryAdjustmentPolicyVersion: 1,
    ...Object.fromEntries(fields.map((field) => [field, row[field] ?? null])), reversedByAdjustmentId: reversed?.reversalAdjustmentId ?? null };
}
async function listHotelInventoryAdjustmentsHandler(request, services = {}) {
  const input = policy.object(request.data, ["hotelUid", "afterAdjustmentId"]), hotelUid = requireDocumentId(input.hotelUid, "hotelUid");
  const db = services.firestore || admin.firestore();
  return db.runTransaction(async (tx) => {
    await authorize(db, tx, request, hotelUid, "read", services);
    let query = db.collection(`hotels/${hotelUid}/inventoryAdjustments`).orderBy("postedAtMillis", "desc").orderBy(admin.firestore.FieldPath.documentId(), "desc");
    if (input.afterAdjustmentId != null) {
      const after = await tx.get(adjustmentRef(db, hotelUid, requireDocumentId(input.afterAdjustmentId, "afterAdjustmentId")));
      if (!after.exists || after.data().hotelUid !== hotelUid) throw new HttpsError("invalid-argument", "The inventory adjustment cursor does not belong to this hotel.");
      query = query.startAfter(after);
    }
    const rows = await tx.get(query.limit(26)), page = rows.docs.slice(0, 25);
    const reversals = await Promise.all(page.map((doc) => tx.get(reversalRef(db, hotelUid, doc.id))));
    if (page.some((doc) => doc.data().hotelUid !== hotelUid)) throw new HttpsError("failed-precondition", "Inventory adjustment scope needs reconciliation.");
    const settings = await hotelSettings(db, tx, hotelUid);
    return { hotelUid, inventoryAdjustmentPolicyVersion: 1, hotelCurrency: settings.hotelCurrency,
      today: validTimeZone(settings.timeZone) ? localDate(services.now?.() ?? Date.now(), settings.timeZone) : null,
      adjustments: page.map((doc, index) => projection(doc, reversals[index].data())), nextCursor: rows.docs.length > 25 ? page.at(-1).id : null };
  }, { readOnly: true });
}
async function listHotelInventoryAdjustmentChoicesHandler(request, services = {}) {
  const input = policy.object(request.data, ["hotelUid", "kind", "afterId", "query"]), hotelUid = requireDocumentId(input.hotelUid, "hotelUid");
  if (!["locations", "catalogproducts"].includes(input.kind)) throw new HttpsError("invalid-argument", "Choose a supported inventory adjustment source list.");
  const search = input.query == null ? "" : text(input.query, "Search prefix", 200).toLowerCase();
  const db = services.firestore || admin.firestore();
  return db.runTransaction(async (tx) => {
    try { await authorize(db, tx, request, hotelUid, "read", services); }
    catch (error) { if (error.code !== "permission-denied") throw error; await authorize(db, tx, request, hotelUid, "create", services); }
    const settings = await hotelSettings(db, tx, hotelUid);
    let query = db.collection(`hotels/${hotelUid}/${input.kind}`).orderBy(admin.firestore.FieldPath.documentId());
    if (input.afterId != null) query = query.startAfter(requireDocumentId(input.afterId, "afterId"));
    const snapshot = await tx.get(query.limit(51)), page = snapshot.docs.slice(0, 50);
    const choices = page.filter((doc) => {
      const row = doc.data();
      return !isArchived(row) && typeof row.name === "string" && row.name.trim() && row.name.toLowerCase().startsWith(search)
        && (input.kind === "locations" || row.inventoryTracked === true && ["g", "kg", "ml", "l", "each"].includes(row.baseUnit));
    }).map((doc) => ({ id: doc.id, name: doc.data().name.slice(0, 200), ...(input.kind === "catalogproducts" ? { baseUnit: doc.data().baseUnit } : {}) }));
    return { hotelUid, inventoryAdjustmentPolicyVersion: 1, kind: input.kind, hotelCurrency: settings.hotelCurrency,
      today: validTimeZone(settings.timeZone) ? localDate(services.now?.() ?? Date.now(), settings.timeZone) : null, choices,
      scannedCount: page.length, nextCursor: snapshot.docs.length > 50 ? page.at(-1).id : null };
  }, { readOnly: true });
}
const options = { region: "us-central1", cors: true, maxInstances: 5, concurrency: 8, timeoutSeconds: 120 };
module.exports = { validateManualPeriodEvidence, recordHotelInventoryAdjustmentHandler, reverseHotelInventoryAdjustmentHandler, listHotelInventoryAdjustmentsHandler, listHotelInventoryAdjustmentChoicesHandler,
  recordHotelInventoryAdjustment: onCall(options, gated(recordHotelInventoryAdjustmentHandler)),
  reverseHotelInventoryAdjustment: onCall(options, gated(reverseHotelInventoryAdjustmentHandler)),
  listHotelInventoryAdjustments: onCall(options, gated(listHotelInventoryAdjustmentsHandler)),
  listHotelInventoryAdjustmentChoices: onCall(options, gated(listHotelInventoryAdjustmentChoicesHandler)) };
