import { describe, it, expect, vi } from "vitest";
import { publishReviewedRules, verifyPublishedRules, STORAGE_BUCKET } from "../../scripts/firebase/saas-rules-release.mjs";

function fixture() {
  let firestore = { name: "old-firestore", source: [{ content: "old firestore" }] };
  let storage = { name: "old-storage", source: [{ content: "old storage" }] };
  const events = [];
  const rules = {
    getFirestoreRuleset: async () => firestore,
    getStorageRuleset: async (bucket) => { expect(bucket).toBe(STORAGE_BUCKET); return storage; },
    createRulesFileFromSource: (name, content) => ({ name, content }),
    createRuleset: vi.fn(async (file) => ({ name: file.name, source: [file] })),
    releaseFirestoreRuleset: vi.fn(async (next) => { events.push("firestore"); firestore = next; }),
    releaseStorageRuleset: vi.fn(async (next, bucket) => { expect(bucket).toBe(STORAGE_BUCKET); events.push("storage"); storage = next; }),
  };
  return { rules, events };
}

describe("reviewed Rules release safeguards", () => {
  it("saves the recoverable previous sources before publishing and verifies both resulting releases", async () => {
    const { rules, events } = fixture();
    await publishReviewedRules(rules, ["new firestore", "new storage"], async (backup) => {
      expect(backup.map((r) => r.name)).toEqual(["old-firestore", "old-storage"]);
      events.push("backup");
    });
    expect(events).toEqual(["backup", "firestore", "storage"]);
    await expect(verifyPublishedRules(rules, ["new firestore", "new storage"])).resolves.toHaveLength(2);
  });
  it("does not publish anything if either source fails compilation", async () => {
    const { rules } = fixture();
    rules.createRuleset.mockImplementation(async (file) => { if (file.name === "storage.rules") throw new Error("invalid rules"); return { name: file.name }; });
    await expect(publishReviewedRules(rules, ["new firestore", "invalid"], async () => {})).rejects.toThrow("invalid rules");
    expect(rules.releaseFirestoreRuleset).not.toHaveBeenCalled();
    expect(rules.releaseStorageRuleset).not.toHaveBeenCalled();
  });
  it("refuses to create or publish releases when the backup cannot be saved", async () => {
    const { rules } = fixture();
    await expect(publishReviewedRules(rules, ["new firestore", "new storage"], async () => { throw new Error("backup failed"); })).rejects.toThrow("backup failed");
    expect(rules.createRuleset).not.toHaveBeenCalled();
    expect(rules.releaseFirestoreRuleset).not.toHaveBeenCalled();
  });
  it("refuses activation when either published source differs from the reviewed release", async () => {
    const { rules } = fixture();
    await expect(verifyPublishedRules(rules, ["new firestore", "old storage"])).rejects.toThrow("differ");
    await expect(verifyPublishedRules(rules, ["old firestore", "new storage"])).rejects.toThrow("differ");
  });
});
