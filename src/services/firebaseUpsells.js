import { db, doc, getDoc, setDoc } from "../firebaseConfig";

const UPSELL_SETTINGS_DOC_ID = "upsells";

function normalizePackageCodes(packageCodes) {
  if (!Array.isArray(packageCodes)) return [];

  return Array.from(
    new Set(
      packageCodes
        .map((code) => String(code || "").trim().toUpperCase())
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b));
}

export async function getUpsellSettings(hotelUid) {
  if (!hotelUid) return { packageCodes: [] };

  const settingsRef = doc(db, `hotels/${hotelUid}/settings`, UPSELL_SETTINGS_DOC_ID);
  const snapshot = await getDoc(settingsRef);
  const data = snapshot.exists() ? snapshot.data() : {};

  return {
    ...data,
    packageCodes: normalizePackageCodes(data.packageCodes),
  };
}

export async function saveUpsellPackageCodes(hotelUid, packageCodes) {
  if (!hotelUid) return;

  const settingsRef = doc(db, `hotels/${hotelUid}/settings`, UPSELL_SETTINGS_DOC_ID);
  await setDoc(
    settingsRef,
    {
      packageCodes: normalizePackageCodes(packageCodes),
      updatedAt: new Date(),
    },
    { merge: true }
  );
}
