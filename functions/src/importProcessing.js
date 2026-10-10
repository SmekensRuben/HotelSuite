const { stableId } = require("./importIdentity");

function importRunId(object) {
  if (!object.bucket || !object.name || !object.generation) throw new Error("Import object needs bucket/name/generation identity");
  return stableId(String(object.bucket), String(object.name), String(object.generation));
}

// A checkpoint and all business writes commit together. Replaying parsing after a
// crash skips committed chunks, including append-only lists and append-mode rows.
async function commitImportChunk({ db, runRef, owner, chunkIndex, rows, mergeDocuments, ancestorPaths, years = [] }) {
  const chunkRef = runRef.collection("chunks").doc(String(chunkIndex).padStart(8, "0"));
  const inputHash = stableId(rows, years);
  return db.runTransaction(async (tx) => {
    const [run, checkpoint] = await Promise.all([tx.get(runRef), tx.get(chunkRef)]);
    if (!run.exists || run.data().owner !== owner || run.data().state !== "processing") throw new Error("Import run lease lost");
    if (checkpoint.exists) {
      if (checkpoint.data().inputHash !== inputHash) throw new Error("Import chunk changed on replay; operator review required");
      tx.update(runRef, { leaseUntil: Date.now() + 300000, updatedAt: Date.now() });
      return checkpoint.data().summary;
    }
    if (chunkIndex > 0) {
      const previous = await tx.get(runRef.collection("chunks").doc(String(chunkIndex - 1).padStart(8, "0")));
      if (!previous.exists) throw new Error("Import chunks must commit in source order");
    }
    const targets = rows.map((row) => db.doc(row.docPath));
    const existing = await Promise.all(targets.map((ref) => tx.get(ref)));
    const ancestors = [...new Set(rows.flatMap((row) => ancestorPaths(row.docPath)))];
    if (rows.length + ancestors.length > 450) throw new Error("Import chunk exceeds atomic write bounds");
    const summary = { writtenCount: rows.length, firstWrittenPath: rows[0]?.docPath || null, affectedStayPatternYears: years };
    ancestors.forEach((path) => tx.set(db.doc(path), { queryable: true }, { merge: true }));
    rows.forEach((row, index) => {
      const payload = existing[index].exists ? mergeDocuments(existing[index].data() || {}, row.payload) : row.payload;
      if (row.writeMode === "merge") tx.set(targets[index], payload, { merge: true });
      else tx.set(targets[index], payload);
    });
    tx.create(chunkRef, { schemaVersion: 1, inputHash, summary, completedAt: Date.now() });
    tx.update(runRef, { leaseUntil: Date.now() + 300000, updatedAt: Date.now() });
    return summary;
  });
}
module.exports = { importRunId, commitImportChunk };
