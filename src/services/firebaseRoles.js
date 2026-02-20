import {
  addDoc,
  collection,
  db,
  deleteDoc,
  doc,
  getDocs,
  updateDoc,
} from "../firebaseConfig";

function rolesCollection(hotelUid) {
  if (!hotelUid) {
    throw new Error("hotelUid is required");
  }

  return collection(db, `hotels/${hotelUid}/roles`);
}

export async function getRoles(hotelUid) {
  const snapshot = await getDocs(rolesCollection(hotelUid));
  return snapshot.docs.map((roleDoc) => ({
    id: roleDoc.id,
    ...roleDoc.data(),
  }));
}

export async function createRole(hotelUid, payload) {
  return addDoc(rolesCollection(hotelUid), payload);
}

export async function updateRole(hotelUid, roleId, payload) {
  if (!roleId) {
    throw new Error("roleId is required");
  }

  await updateDoc(doc(db, `hotels/${hotelUid}/roles`, roleId), payload);
}

export async function deleteRole(hotelUid, roleId) {
  if (!roleId) {
    throw new Error("roleId is required");
  }

  await deleteDoc(doc(db, `hotels/${hotelUid}/roles`, roleId));
}
