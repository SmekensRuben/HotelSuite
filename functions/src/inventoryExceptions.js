const { HttpsError } = require("firebase-functions/v2/https");
const { checkpointId, stateRef, sequence } = require("./inventoryMovements");

const MAX_EVENTS = 1000;
const kindLabels = { receipt: "Receipt", reversal: "Receipt reversal", transfer_in: "Transfer in", transfer_out: "Transfer out",
  waste: "Waste", breakage: "Breakage", physical_return: "Physical supplier return", adjustment_reversal: "Movement reversal" };

function movementEvidence(snapshot) {
  const row = snapshot.data();
  return { movementId: snapshot.id, kind: row.kind, label: kindLabels[row.kind] || "Inventory event", sequence: row.sequence,
    businessDate: row.receivedOn || null, postedAtMillis: row.postedAt?.toMillis?.() ?? null,
    orderId: row.orderId || null, receiptId: row.receiptId || null, adjustmentId: row.adjustmentId || null,
    originalMovementId: row.originalMovementId || null, reference: row.reference || null,
    lines: (row.lines || []).map((line) => ({ catalogProductId: line.catalogProductId, catalogProductName: line.catalogProductName || line.catalogProductId,
      quantity: line.quantity ?? null, baseUnit: line.baseUnit || null })),
    coverageGaps: (row.coverageGaps || []).map((gap) => ({ reason: gap.reason || gap.code || "Unknown conversion", supplierProductId: gap.supplierProductId || null })) };
}

function bounded(snapshot) {
  if (snapshot.docs.length > MAX_EVENTS) throw new HttpsError("resource-exhausted", "More than 1,000 events require a narrower inventory review. Evidence is unavailable rather than truncated; ask an inventory supervisor to reconcile the source records and start a new count with a controlled cutoff.");
  return snapshot.docs;
}

// Read-only projection of the existing ledger. There is deliberately no action
// that acknowledges, clears or rewrites an uncertain physical cutoff.
async function countExceptions(db, tx, hotelUid, stockCountId, locationId) {
  const [parent, location, checkpoint, state] = await Promise.all([
    tx.get(db.doc(`hotels/${hotelUid}/stockCounts/${stockCountId}`)),
    tx.get(db.doc(`hotels/${hotelUid}/stockCounts/${stockCountId}/locations/${locationId}`)),
    tx.get(db.doc(`hotels/${hotelUid}/inventoryCheckpoints/${checkpointId(stockCountId, locationId)}`)),
    tx.get(stateRef(db, hotelUid, locationId)),
  ]);
  if (!parent.exists || !location.exists || parent.data().inventoryPolicyVersion !== 1
    || !parent.data().locations?.some((item) => item.locationId === locationId) || location.data().locationId !== locationId) {
    throw new HttpsError("failed-precondition", "Select a catalog count and one of its recorded locations to review inventory exceptions.");
  }
  const count = parent.data(), area = location.data(), closed = checkpoint.exists ? checkpoint.data() : null;
  if (closed && (closed.hotelUid !== hotelUid || closed.locationId !== locationId || closed.stockCountId !== stockCountId || closed.inventoryPolicyVersion !== 1)) {
    throw new HttpsError("failed-precondition", "Count checkpoint scope needs reconciliation.");
  }
  const currentSequence = sequence(state), end = closed ? closed.sequence - 1 : currentSequence;
  const start = area.countingStartedSequence;
  const issues = [];
  if (area.status === "Finished" && !closed || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || start > end || end > currentSequence) {
    issues.push({ code: "checkpoint-cutoff-unknown", detail: `The posting boundary for count ${stockCountId} cannot be verified. Ask an inventory supervisor to check its source records; use a new physical count for a reliable future baseline.`, stockCountId, evidence: [] });
  } else if (start !== end) {
    const base = (collection) => db.collection(`hotels/${hotelUid}/${collection}`).where("locationId", "==", locationId)
      .where("sequence", ">", start).where("sequence", "<=", end).orderBy("sequence").limit(MAX_EVENTS + 1);
    const [movementDocs, checkpointDocs] = await Promise.all([tx.get(base("inventoryMovements")), tx.get(base("inventoryCheckpoints"))]);
    const movementRows = bounded(movementDocs), checkpointRows = bounded(checkpointDocs);
    const events = [...movementRows.map(movementEvidence), ...checkpointRows.map((doc) => ({ checkpointId: doc.id, stockCountId: doc.data().stockCountId,
      label: "Another completed count", sequence: doc.data().sequence, businessDate: doc.data().businessDate, lines: [] }))].sort((a, b) => a.sequence - b.sequence);
    issues.push({ code: "postings-during-count", stockCountId,
      detail: `${events.length} recorded event(s) occurred after this count started at sequence ${start} and before ${closed ? `its closing checkpoint ${closed.sequence}` : `the current sequence ${currentSequence}`}. Check whether each physical delivery or movement was included in the quantities counted. If the cutoff is uncertain, keep this evidence and start a new count after coordinating movements.`, evidence: events });
    if (events.length !== end - start || events.some((event, index) => event.sequence !== start + index + 1)) {
      issues.push({ code: "posting-evidence-incomplete", stockCountId, detail: `Posting sequences ${start + 1}–${end} contain missing or duplicate evidence. An inventory supervisor must reconcile source records; do not infer missing quantities or treat a recount as repair of historical evidence.`, evidence: [] });
    }
  }
  if (closed) {
    const after = bounded(await tx.get(db.collection(`hotels/${hotelUid}/inventoryMovements`).where("locationId", "==", locationId)
      .where("sequence", ">", closed.sequence).orderBy("sequence").limit(MAX_EVENTS + 1)));
    for (const doc of after.filter((item) => !item.data().receivedOn || item.data().receivedOn <= closed.businessDate)) {
      const evidence = movementEvidence(doc);
      issues.push({ code: "late-posting-after-closing", stockCountId, evidence: [evidence],
        detail: `${evidence.label} ${doc.id} was posted at sequence ${evidence.sequence}, after checkpoint ${closed.sequence}, with business date ${evidence.businessDate || "unknown"}. The completed count dated ${closed.businessDate} remains unchanged. Check the source event and its actual physical timing.` });
    }
  }
  return { hotelUid, stockCountId, locationId, inventoryPolicyVersion: 1, revision: count.revision ?? 0,
    businessDate: count.businessDate, finished: area.status === "Finished" || count.status === "Finished",
    countingStartedSequence: Number.isSafeInteger(start) ? start : null, checkedThroughSequence: currentSequence, issues };
}

module.exports = { movementEvidence, countExceptions };
