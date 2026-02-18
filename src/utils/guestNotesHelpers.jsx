import { db, collection, doc, addDoc, getDocs } from "../firebaseConfig";

/**
 * Voegt een nieuwe notitie toe voor een gast op basis van naam.
 * @param {string} hotelUid - De unieke ID van het hotel
 * @param {string} guestName - De naam van de gast (zoals "Tucker, Scott")
 * @param {string} noteText - De inhoud van de notitie
 */
export async function addNote(hotelUid, guestName, noteText) {
  try {
    if (!hotelUid || !guestName || !noteText) {
      throw new Error("Hotel, gastnaam en notitie zijn verplicht.");
    }
    // Maak Firestore-proof keys (je kan guestName als document-id nemen, subcollectie "notes")
    const safeGuestName = String(guestName).replace(/[.#$/[\]]/g, "-");

    const notesCol = collection(db, `hotels/${hotelUid}/notes/${safeGuestName}/notes`);
    const noteObj = {
      note: noteText,
      date: new Date().toISOString()
    };
    await addDoc(notesCol, noteObj);
  } catch (error) {
    console.error("Fout bij toevoegen notitie:", error);
    throw error;
  }
}

// Haal ALLE guest notes op voor een hotel (gegroepeerd per guestName)
export async function getAllGuestNotes(hotelUid) {
  if (!hotelUid) return {};
  // Haal alle guestNames op
  const notesRoot = collection(db, `hotels/${hotelUid}/notes`);
  const guestNoteDocs = await getDocs(notesRoot);

  const allNotes = {};

  for (const guestDoc of guestNoteDocs.docs) {
    const guestName = guestDoc.id;
    const subNotesCol = collection(db, `hotels/${hotelUid}/notes/${guestName}/notes`);
    const subNotesSnap = await getDocs(subNotesCol);
    allNotes[guestName] = {};
    subNotesSnap.forEach(docSnap => {
      allNotes[guestName][docSnap.id] = docSnap.data();
    });
  }
  return allNotes; // { "Tucker-Scott": {noteId: {...}}, ... }
}
