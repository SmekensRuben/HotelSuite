import { describe, it, expect } from "vitest";
import { migratePrivateWorkflows, attachmentDescriptor } from "../../scripts/firebase/private-workflows-migration.mjs";
const db = { runTransaction() { throw new Error("No records should change in an orphan-token migration."); } };
function objectStore(retainTokens = false) {
  const generations = new Map([
    ["orphan:1", { generation: "1", metageneration: "4", metadata: { firebaseStorageDownloadTokens: "first-token", unrelated: "preserved" } }],
    ["orphan:2", { generation: "2", metageneration: "5", metadata: { firebaseStorageDownloadTokens: "second-token" } }],
  ]);
  const updates = [];
  return { generations, updates, file(name, options = {}) {
    const key = name + ":" + options.generation;
    return { async getMetadata() { return [structuredClone(generations.get(key))]; },
      async setMetadata(patch, precondition) {
        const current = generations.get(key);
        expect(precondition.ifMetagenerationMatch).toBe(current.metageneration);
        expect(patch.metadata.firebaseStorageDownloadTokens).toBeNull();
        updates.push(key);
        if (!retainTokens) delete current.metadata.firebaseStorageDownloadTokens;
        current.metageneration = String(Number(current.metageneration) + 1);
      } };
  } };
}
const inspection = { summary: { issues: [] }, contracts: [], roomingLists: [], objects: [{ name: "orphan", generation: "1" }, { name: "orphan", generation: "2" }] };
describe("Google Cloud Storage token deletion contract", () => {
  it("revokes every retained generation with a metadata precondition and preserves unrelated metadata", async () => {
    const bucket = objectStore();
    await migratePrivateWorkflows(db, bucket, inspection, {}, "operator");
    expect(bucket.updates).toEqual(["orphan:1", "orphan:2"]);
    expect(bucket.generations.get("orphan:1").metadata).toEqual({ unrelated: "preserved" });
    await migratePrivateWorkflows(db, bucket, inspection, {}, "operator");
    expect(bucket.updates).toHaveLength(2);
  });
  it("refuses completion if the provider still returns an old token", async () => {
    await expect(migratePrivateWorkflows(db, objectStore(true), inspection, {}, "operator")).rejects.toThrow("still has a download token");
  });
  it("only imports a Firebase legacy URL from the known bucket and correct contract", () => {
    const path = "hotels/hotel-a/contracts/contract-a/file.pdf";
    const file = attachmentDescriptor({ fileName: "file.pdf", downloadUrl: "https://firebasestorage.googleapis.com/v0/b/hotel-toolkit.firebasestorage.app/o/" + encodeURIComponent(path) + "?token=fictional" }, "hotel-a", "contract-a");
    expect(file.sourcePath).toBe(path); expect(file.filePath).toMatch(/^private\/contracts\/hotel-a\/contract-a\//);
    for (const url of ["http://firebasestorage.googleapis.com/v0/b/hotel-toolkit.firebasestorage.app/o/file", "https://attacker.example.test/file", "https://firebasestorage.googleapis.com/v0/b/other-bucket/o/" + encodeURIComponent(path)]) expect(() => attachmentDescriptor({ fileName: "file.pdf", downloadUrl: url }, "hotel-a", "contract-a")).toThrow();
  });
});
