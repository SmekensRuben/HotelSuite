import {
  collection,
  db,
  doc,
  getDoc,
  getDocs,
  query,
  updateDoc,
  where,
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

export async function updateUserRoles(userId, hotelUid, roles) {
  const userRef = doc(db, "users", userId);
  const payload = hotelUid
    ? { [`roles.${hotelUid}`]: roles }
    : { roles };

  try {
    await updateDoc(userRef, payload);
  } catch (error) {
    console.error("Kon gebruikersrollen niet bijwerken:", error);
    throw error;
  }
}

export async function getUserDisplayName(userIdentifier) {
  if (!userIdentifier) return "-";

  try {
    const byIdRef = doc(db, "users", userIdentifier);
    const byIdSnap = await getDoc(byIdRef);

    if (byIdSnap.exists()) {
      const userData = byIdSnap.data() || {};
      const fullName = `${userData.firstName || ""} ${userData.lastName || ""}`.trim();
      return fullName || userData.email || String(userIdentifier);
    }

    if (String(userIdentifier).includes("@")) {
      const usersCollection = collection(db, "users");
      const q = query(usersCollection, where("email", "==", userIdentifier));
      const emailSnap = await getDocs(q);
      if (!emailSnap.empty) {
        const userData = emailSnap.docs[0].data() || {};
        const fullName = `${userData.firstName || ""} ${userData.lastName || ""}`.trim();
        return fullName || userData.email || String(userIdentifier);
      }
    }

    return String(userIdentifier);
  } catch (error) {
    console.error("Kon gebruiker niet ophalen:", error);
    return String(userIdentifier);
  }
}
