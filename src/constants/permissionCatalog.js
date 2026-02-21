export const PERMISSION_CATALOG = {
  products: ["create", "read", "update", "delete"],
  users: ["create", "read", "update", "delete"],
};

export function listAllPermissionKeys() {
  return Object.entries(PERMISSION_CATALOG).flatMap(([feature, actions]) =>
    actions.map((action) => `${feature}.${action}`)
  );
}
