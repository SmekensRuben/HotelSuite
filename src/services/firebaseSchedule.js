import { db, doc, getDoc, serverTimestamp, setDoc } from "../firebaseConfig";

function createScheduleDocRef(hotelUid, dateKey) {
  return doc(db, `hotels/${hotelUid}/schedule`, dateKey);
}

export function formatDateKey(dateInput) {
  if (!dateInput) return "";
  const date = new Date(dateInput);
  if (Number.isNaN(date.getTime())) return "";
  date.setHours(0, 0, 0, 0);
  const tzAdjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return tzAdjusted.toISOString().slice(0, 10);
}

export async function getScheduleForDate(hotelUid, dateKey) {
  if (!hotelUid || !dateKey) {
    return { date: dateKey || "", assignments: {} };
  }

  const ref = createScheduleDocRef(hotelUid, dateKey);
  const snapshot = await getDoc(ref);

  if (!snapshot.exists()) {
    return { date: dateKey, assignments: {} };
  }

  const data = snapshot.data() || {};
  const assignments =
    data.assignments && typeof data.assignments === "object" ? data.assignments : {};

  return {
    date: data.date || dateKey,
    assignments,
    updatedAt: data.updatedAt || null,
  };
}

export async function saveScheduleAssignments(hotelUid, dateKey, assignments = {}) {
  if (!hotelUid || !dateKey) {
    return { date: dateKey || "", assignments: {} };
  }

  const ref = createScheduleDocRef(hotelUid, dateKey);
  const payload = {
    date: dateKey,
    assignments,
    updatedAt: serverTimestamp(),
  };

  await setDoc(ref, payload, { merge: true });

  return payload;
}
