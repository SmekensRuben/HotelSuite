import { addDoc, collection, db, serverTimestamp } from '../firebaseConfig';

export async function triggerScheduledOccupancyMail({ hotelUid = null, requestedBy = null } = {}) {
  const triggerRef = collection(db, 'scheduledMails', 'scheduledOccupancyMail', 'manualTriggers');
  const docRef = await addDoc(triggerRef, {
    requestedAt: serverTimestamp(),
    requestedBy: requestedBy || null,
    requestedFromHotelUid: hotelUid || null,
    status: 'queued',
  });

  return docRef.id;
}
