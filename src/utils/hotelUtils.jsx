// src/utils/hotelUtils.js
// Retrieve the UID of the currently selected hotel from session storage
export function getSelectedHotelUid() {
  return sessionStorage.getItem("selectedHotelUid");
}

// Persist the UID of the currently selected hotel to session storage
export function setSelectedHotelUid(uid) {
  if (uid) {
    sessionStorage.setItem("selectedHotelUid", uid);
  } else {
    sessionStorage.removeItem("selectedHotelUid");
  }
}
