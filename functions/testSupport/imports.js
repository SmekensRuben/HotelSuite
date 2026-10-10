// Transactional in-memory Firebase boundary used only by local Node regressions.
// Commits are serialized and atomic, including injectable pre/post-commit failures.
class ImportTestDb {
  constructor(entries = {}) { this.records = new Map(Object.entries(entries)); this.tail = Promise.resolve(); this.readPaths = []; this.failBefore = null; this.failAfter = null; }
  doc(path) {
    return { path, id: path.split("/").pop(), get: async () => this.snapshot(path),
      collection: (name) => this.collection(`${path}/${name}`),
      set: async (data, options) => this.records.set(path, options?.merge ? { ...this.records.get(path), ...structuredClone(data) } : structuredClone(data)),
      delete: async () => this.records.delete(path) };
  }
  snapshot(path) {
    this.readPaths.push(path);
    const value = this.records.get(path);
    return { id: path.split("/").pop(), ref: this.doc(path), exists: value !== undefined,
      updateTime: { seconds: 1, nanoseconds: 0 }, data: () => value === undefined ? undefined : structuredClone(value) };
  }
  collection(path) {
    const query = (filters = [], max = Infinity) => ({
      doc: (id) => this.doc(`${path}/${id}`),
      where: (field, op, value) => { if (op !== "==") throw new Error("Unsupported test query"); return query([...filters, [field, value]], max); },
      limit: (count) => query(filters, count),
      get: async () => {
        this.readPaths.push(path);
        const docs = [...this.records.entries()].filter(([key, value]) => key.startsWith(path + "/")
          && key.slice(path.length + 1).split("/").length === 1 && filters.every(([field, expected]) => value[field] === expected))
          .slice(0, max).map(([key]) => this.snapshot(key));
        return { docs, size: docs.length, empty: !docs.length };
      },
    });
    return query();
  }
  async runTransaction(handler) {
    let unlock;
    const lock = new Promise((resolve) => { unlock = resolve; });
    const previous = this.tail; this.tail = previous.then(() => lock);
    await previous;
    const pending = [];
    let wrote = false;
    const tx = { get: async (ref) => { if (wrote) throw new Error("Read after transaction write"); return this.snapshot(ref.path); },
      set: (ref, data, options) => { wrote = true; pending.push({ path: ref.path, data, merge: options?.merge }); },
      update: (ref, data) => { wrote = true; pending.push({ path: ref.path, data, merge: true }); },
      create: (ref, data) => { wrote = true; if (this.records.has(ref.path)) throw new Error("Already exists"); pending.push({ path: ref.path, data }); },
      delete: (ref) => { wrote = true; pending.push({ path: ref.path, remove: true }); } };
    try {
      const result = await handler(tx);
      if (this.failBefore?.(pending)) throw new Error("Injected failure before atomic commit");
      for (const write of pending) {
        if (write.remove) this.records.delete(write.path);
        else this.records.set(write.path, structuredClone(write.merge ? { ...this.records.get(write.path), ...write.data } : write.data));
      }
      if (this.failAfter?.(pending)) throw new Error("Injected crash after atomic commit");
      return result;
    } finally { unlock(); }
  }
}
class ImportTestBucket {
  constructor() { this.objects = new Map(); this.saves = 0; this.createAttempts = 0; this.failAfterSave = false; }
  file(path) {
    return { save: async (bytes, options) => {
      this.createAttempts += 1;
      if (options.preconditionOpts?.ifGenerationMatch !== 0) throw new Error("Import save must be create-only");
      if (this.objects.has(path)) { const error = new Error("Precondition failed"); error.code = 412; throw error; }
      this.objects.set(path, { bytes, metadata: options.metadata.metadata, generation: "1" }); this.saves += 1;
      if (this.failAfterSave) { this.failAfterSave = false; throw new Error("Injected crash after save"); }
    }, getMetadata: async () => [this.objects.get(path)], createReadStream: () => require("node:stream").Readable.from(this.objects.get(path).bytes) };
  }
}
module.exports = { ImportTestDb, ImportTestBucket };
