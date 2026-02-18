import { auth } from "../firebaseConfig";
import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";

export async function login(email, password) {
  try {
    const result = await signInWithEmailAndPassword(auth, email, password);
    return result.user;
  } catch (error) {
    console.error("Login fout:", error);
    throw error;
  }
}

export async function logout() {
  try {
    await signOut(auth);
    sessionStorage.clear();
  } catch (error) {
    console.error("Logout fout:", error);
  }
}

export async function verifyCurrentUserPassword(password) {
  if (typeof password !== "string" || password.trim() === "") {
    throw new Error("Geen wachtwoord opgegeven.");
  }

  const user = auth.currentUser;

  if (!user?.email) {
    throw new Error("Geen ingelogde gebruiker gevonden.");
  }

  const credential = EmailAuthProvider.credential(user.email, password);
  await reauthenticateWithCredential(user, credential);
}
