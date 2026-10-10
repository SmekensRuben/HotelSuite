import {
  collection,
  db,
  doc,
  getDoc,
  getDocs,
  functions,
  httpsCallable,
} from "../firebaseConfig";

export async function getAllUsers() {
  try {
    const usersCollection = collection(db, "users");
    const snapshot = await getDocs(usersCollection);
    return snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
  } catch (error) {
    console.error("Kon gebruikers niet ophalen:", error);
    throw error;
  }
}

export async function getUserById(userId) {
  if (!userId) {
    throw new Error("userId is required");
  }

  try {
    const userRef = doc(db, "users", userId);
    const snapshot = await getDoc(userRef);

    if (!snapshot.exists()) {
      return null;
    }

    return {
      id: snapshot.id,
      ...snapshot.data(),
    };
  } catch (error) {
    console.error("Kon gebruiker niet ophalen:", error);
    throw error;
  }
}

export async function getUserMemberships(userId, hotelUids) {
  if (!userId) throw new Error("userId is required");
  const normalizedHotelUids = [...new Set((hotelUids || []).map((value) => String(value || "").trim()).filter(Boolean))];
  const snapshots = await Promise.all(
    normalizedHotelUids.map(async (hotelUid) => ({
      hotelUid,
      snapshot: await getDoc(doc(db, `hotels/${hotelUid}/members`, userId)),
    })),
  );
  return Object.fromEntries(snapshots.map(({ hotelUid, snapshot }) => [
    hotelUid,
    snapshot.exists() && Array.isArray(snapshot.data()?.permissions)
      ? snapshot.data().permissions
      : [],
  ]));
}

export async function updateUserWithMemberships(userId, profile, memberships, expectedAccessRevision = 0) {
  if (!userId) throw new Error("userId is required");
  const updateAccess = httpsCallable(functions, "updateUserAccess");
  const result = await updateAccess({ userId, profile, memberships, expectedAccessRevision });
  return result.data;
}

export async function getHotelUserDisplayName(hotelUid, userId) {
  if (!hotelUid) throw new Error("hotelUid is required");
  if (!userId) return "-";
  const result = await httpsCallable(functions, "getHotelUserDisplayName")({ hotelUid, userId });
  return result.data.displayName || String(userId);
}
