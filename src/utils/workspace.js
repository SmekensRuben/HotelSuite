export function workspaceHome({ isPlatformAdmin, hotelUids = [] }) {
  return isPlatformAdmin ? "/platform" : hotelUids.length ? "/dashboard" : "/access";
}
