import { db, doc, getDoc } from "../firebaseConfig";

export async function fetchUserRole(uid) {
  try {
    const userDoc = doc(db, "users", uid);
    const snapshot = await getDoc(userDoc);
    return snapshot.exists() ? snapshot.data().role || null : null;
  } catch (error) {
    console.error("Fout bij ophalen gebruikersrol:", error);
    return null;
  }
}

export async function fetchUserProfile(uid) {
  try {
    const userDoc = doc(db, "users", uid);
    const snapshot = await getDoc(userDoc);
    return snapshot.exists() ? snapshot.data() : null;
  } catch (error) {
    console.error("Fout bij ophalen gebruikersprofiel:", error);
    return null;
  }
}
