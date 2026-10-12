import { auth } from "../firebaseConfig";

// Share only concurrent reads. Operational records are never kept as a settled cache.
const reads = new Map();
const identities = new WeakMap();
const hotelEpochs = new Map();
let identitySequence = 0;
let accessEpoch = 0;

export function requireServerSnapshot(snapshot) {
  if (snapshot.metadata?.fromCache === true) throw new Error("Hotel data could not be verified with the server. Reconnect and retry.");
  return snapshot;
}

export function invalidateProcurementReads(hotelUid) {
  if (hotelUid) {
    hotelEpochs.set(hotelUid, (hotelEpochs.get(hotelUid) || 0) + 1);
    for (const [key, entry] of reads) if (entry.hotelUid === hotelUid) reads.delete(key);
  } else {
    accessEpoch += 1;
    hotelEpochs.clear();
    reads.clear();
  }
}

export function procurementReadScope(hotelUid, scopeKey = "") {
  const actor = auth.currentUser;
  if (!actor?.uid) return null;
  if (!identities.has(actor)) identities.set(actor, ++identitySequence);
  const epoch = accessEpoch;
  const hotelEpoch = hotelEpochs.get(hotelUid) || 0;
  return {
    key: JSON.stringify([identities.get(actor), actor.uid, hotelUid, epoch, hotelEpoch, scopeKey]),
    current: () => auth.currentUser === actor && accessEpoch === epoch && (hotelEpochs.get(hotelUid) || 0) === hotelEpoch,
  };
}

export function poolProcurementRead(hotelUid, resource, load, scopeKey = "") {
  const scope = procurementReadScope(hotelUid, scopeKey);
  if (!scope) return Promise.resolve().then(load);
  const key = `${scope.key}:${resource}`;
  const existing = reads.get(key);
  if (existing) return existing.promise;
  const promise = Promise.resolve().then(load).then((value) => {
    if (!scope.current()) throw new Error("Hotel access changed while loading. Reload this view.");
    return value;
  }).finally(() => {
    if (reads.get(key)?.promise === promise) reads.delete(key);
  });
  reads.set(key, { hotelUid, promise });
  return promise;
}
