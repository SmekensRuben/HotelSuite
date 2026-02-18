import { collection, db, doc, getDocs, updateDoc } from "../firebaseConfig";

export async function getAllUsers() {
  try {
    const usersCollection = collection(db, "users");
    const snapshot = await getDocs(usersCollection);
    return snapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
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
