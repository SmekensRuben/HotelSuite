import {
  addDoc,
  collection,
  db,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  storage,
  ref,
  uploadBytes,
  getDownloadURL,
  writeBatch,
} from "../firebaseConfig";
import { getSelectedHotelUid } from "../utils/hotelUtils";

export function subscribeToChecklistItems(callback) {
  const hotelUid = getSelectedHotelUid();
  if (!hotelUid) return () => {};

  const checklistRef = collection(db, `hotels/${hotelUid}/checklistItems`);
  const q = query(checklistRef, orderBy("createdAt", "desc"));

  return onSnapshot(q, (snapshot) => {
    const checklistItems = snapshot.docs.map((docSnapshot) => ({
      id: docSnapshot.id,
      ...docSnapshot.data(),
    }));

    callback(checklistItems);
  });
}

export function subscribeToChecklistItem(checklistId, callback) {
  const hotelUid = getSelectedHotelUid();
  if (!hotelUid || !checklistId) return () => {};

  const checklistDocRef = doc(db, `hotels/${hotelUid}/checklistItems/${checklistId}`);

  return onSnapshot(checklistDocRef, (snapshot) => {
    if (!snapshot.exists()) {
      callback(null);
      return;
    }

    callback({
      id: snapshot.id,
      ...snapshot.data(),
    });
  });
}

export async function uploadChecklistStepPhotos({ hotelUid, checklistId, stepIndex, files }) {
  const uploads = files.map(async (file, photoIndex) => {
    const fileExtension = file.name.split(".").pop();
    const safeExtension = fileExtension ? `.${fileExtension}` : "";
    const filePath = `hotels/${hotelUid}/checklist/${checklistId}/step-${stepIndex}/${Date.now()}-${photoIndex}${safeExtension}`;
    const fileRef = ref(storage, filePath);

    await uploadBytes(fileRef, file);
    return getDownloadURL(fileRef);
  });

  return Promise.all(uploads);
}

export async function addChecklistItem(item) {
  const hotelUid = getSelectedHotelUid();
  if (!hotelUid) {
    throw new Error("No hotel selected");
  }

  const checklistRef = collection(db, `hotels/${hotelUid}/checklistItems`);
  const createdDoc = await addDoc(checklistRef, {
    name: item.name,
    description: item.description,
    frequency: item.frequency,
    importance: item.importance || "Medium",
    steps: [],
    createdAt: serverTimestamp(),
  });

  const resolvedSteps = await Promise.all(
    item.steps.map(async (step, stepIndex) => {
      const files = Array.isArray(step.photoFiles) ? step.photoFiles : [];
      const photoUrls = files.length
        ? await uploadChecklistStepPhotos({
            hotelUid,
            checklistId: createdDoc.id,
            stepIndex,
            files,
          })
        : [];

      return {
        title: step.title,
        photoUrls,
      };
    })
  );

  await updateDoc(doc(db, `hotels/${hotelUid}/checklistItems/${createdDoc.id}`), {
    steps: resolvedSteps,
    isCompleted: false,
    completedAt: null,
  });
}

export async function updateChecklistItem(checklistId, item) {
  const hotelUid = getSelectedHotelUid();
  if (!hotelUid) {
    throw new Error("No hotel selected");
  }

  const itemRef = doc(db, `hotels/${hotelUid}/checklistItems/${checklistId}`);
  await updateDoc(itemRef, {
    name: item.name,
    description: item.description,
    frequency: item.frequency,
    importance: item.importance || "Medium",
    steps: item.steps.map((step) => ({
      title: step.title,
      photoUrls: Array.isArray(step.photoUrls) ? step.photoUrls : [],
    })),
  });
}

export async function deleteChecklistItem(checklistId) {
  const hotelUid = getSelectedHotelUid();
  if (!hotelUid) {
    throw new Error("No hotel selected");
  }

  await deleteDoc(doc(db, `hotels/${hotelUid}/checklistItems/${checklistId}`));
}

export async function toggleChecklistItemCompleted(checklistId, isCompleted) {
  const hotelUid = getSelectedHotelUid();
  if (!hotelUid) {
    throw new Error("No hotel selected");
  }

  await updateDoc(doc(db, `hotels/${hotelUid}/checklistItems/${checklistId}`), {
    isCompleted,
    completedAt: isCompleted ? serverTimestamp() : null,
  });
}

export async function clearChecklistItemsCompleted(checklistIds) {
  const hotelUid = getSelectedHotelUid();
  if (!hotelUid) {
    throw new Error("No hotel selected");
  }

  if (!Array.isArray(checklistIds) || !checklistIds.length) {
    return;
  }

  const batch = writeBatch(db);

  checklistIds.forEach((checklistId) => {
    const itemRef = doc(db, `hotels/${hotelUid}/checklistItems/${checklistId}`);
    batch.update(itemRef, {
      isCompleted: false,
      completedAt: null,
    });
  });

  await batch.commit();
}
