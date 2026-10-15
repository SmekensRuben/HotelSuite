const assert = require("node:assert/strict");
function memoryDatabase(initial = {}) {
  const records = new Map(Object.entries(initial)), snapshot = (path) => ({ exists: records.has(path), data: () => structuredClone(records.get(path)),
    id: path.split("/").at(-1), ref: doc(path) });
  function doc(path) { return { path, id: path.split("/").at(-1), get: async () => snapshot(path), collection: (name) => collection(`${path}/${name}`) }; }
  function collection(path, filters = [], orders = [], cursor = null, maximum = Infinity, selected = null) {
    const query = { path, isQuery: true, doc: (id = "test-audit") => doc(`${path}/${id}`),
      where: (field, op, value) => collection(path, [...filters, [field, op, value]], orders, cursor, maximum, selected),
      orderBy: (field, direction = "asc") => collection(path, filters, [...orders, [typeof field === "string" ? field : "__name__", direction]], cursor, maximum, selected),
      startAfter: (value) => collection(path, filters, orders, value, maximum, selected),
      limit: (value) => collection(path, filters, orders, cursor, value, selected),
      select: (...fields) => collection(path, filters, orders, cursor, maximum, fields),
      get: async () => {
        const fieldValue = (path, data, field) => field === "__name__" ? path.split("/").at(-1) : data[field];
        let entries = [...records.entries()].filter(([key, row]) => key.startsWith(`${path}/`) && key.slice(path.length + 1).split("/").length === 1
          && filters.every(([field, op, expected]) => op === "==" ? row[field] === expected : op === ">" ? row[field] > expected : op === "<" ? row[field] < expected : op === ">=" ? row[field] >= expected : op === "<=" ? row[field] <= expected : false));
        entries.sort((a, b) => { for (const [field, direction] of orders) {
          const av = fieldValue(a[0], a[1], field), bv = fieldValue(b[0], b[1], field);
          if (av !== bv) return (av < bv ? -1 : 1) * (direction === "desc" ? -1 : 1);
        } return a[0].localeCompare(b[0]); });
        if (cursor) { const cursorId = typeof cursor === "string" ? cursor : cursor.id; const index = entries.findIndex(([key]) => key.split("/").at(-1) === cursorId);
          if (index >= 0) entries = entries.slice(index + 1); }
        const docs = entries.slice(0, maximum).map(([key]) => { const source = snapshot(key); return selected ? { ...source, data: () => Object.fromEntries(selected.filter((field) => Object.hasOwn(source.data(), field)).map((field) => [field, source.data()[field]])) } : source; }); return { docs, size: docs.length, empty: !docs.length };
      } };
    return query;
  }
  let serial = Promise.resolve();
  const db = { records, doc, collection,
    runTransaction(fn) {
      const run = serial.then(async () => {
        const writes = []; let written = false;
        const read = async (ref) => { assert.equal(written, false, "Firestore transaction reads must precede writes"); return ref.isQuery ? ref.get() : snapshot(ref.path); };
        const tx = { get: read, getAll: (...refs) => Promise.all(refs.map(read)),
          create: (ref, data) => { written = true; writes.push(["create", ref.path, data]); },
          set: (ref, data, options) => { written = true; writes.push([options?.merge ? "update" : "set", ref.path, data]); },
          update: (ref, data) => { written = true; writes.push(["update", ref.path, data]); },
          delete: (ref) => { written = true; writes.push(["delete", ref.path]); } };
        const result = await fn(tx);
        for (const [kind, path, data] of writes) {
          if (kind === "create") assert.equal(records.has(path), false);
          if (kind === "delete") records.delete(path); else records.set(path, kind === "update" ? { ...records.get(path), ...data } : data);
        }
        return result;
      }); serial = run.catch(() => {}); return run;
    } };
  return db;
}
module.exports = { memoryDatabase };
