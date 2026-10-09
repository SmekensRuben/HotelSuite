// Release only the default Firestore database and the existing Firebase Storage bucket.
export const STORAGE_BUCKET = "hotel-toolkit.firebasestorage.app";

export async function verifyPublishedRules(rules, sources) {
  const published = await Promise.all([rules.getFirestoreRuleset(), rules.getStorageRuleset(STORAGE_BUCKET)]);
  published.forEach((ruleset, index) => {
    if (ruleset.source.length !== 1 || ruleset.source[0].content !== sources[index]) {
      throw new Error("Published Rules differ from this reviewed release. Activation is blocked.");
    }
  });
  return published.map((r) => r.name);
}

export async function publishReviewedRules(rules, sources, saveBackup) {
  const previous = await Promise.all([rules.getFirestoreRuleset(), rules.getStorageRuleset(STORAGE_BUCKET)]);
  // A recoverable Rules backup is required before any release is changed.
  await saveBackup(previous.map((r, index) => ({ service: index ? STORAGE_BUCKET : "(default)", name: r.name, source: r.source })));
  // Both sources must compile successfully before either is published.
  const prepared = await Promise.all(sources.map((source, index) => rules.createRuleset(
    rules.createRulesFileFromSource(index ? "storage.rules" : "firestore.rules", source),
  )));
  await rules.releaseFirestoreRuleset(prepared[0]);
  await rules.releaseStorageRuleset(prepared[1], STORAGE_BUCKET);
  return verifyPublishedRules(rules, sources);
}
