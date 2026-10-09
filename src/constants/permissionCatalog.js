import catalog from "../../functions/src/permissionCatalog.json";

export const PERMISSION_CATALOG = Object.fromEntries(
  Object.entries(catalog).map(([feature, actions]) => [feature.toLowerCase(), actions])
);

export function listAllPermissionKeys() {
  return Object.entries(PERMISSION_CATALOG).flatMap(([feature, actions]) =>
    [...actions, "*"].map((action) => `${feature}.${action}`)
  );
}
