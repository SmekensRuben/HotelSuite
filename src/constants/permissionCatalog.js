export const PERMISSION_CATALOG = {
  catalogproducts: ["create", "read", "update", "delete"],
  supplierproducts: ["create", "read", "update", "delete"],
  suppliers: ["create", "read", "update", "delete", "password"],
  orders: ["create", "read", "update", "delete"],
  settings: ["create", "read", "update", "delete"],
  users: ["create", "read", "update", "delete"],
};

export function listAllPermissionKeys() {
  return Object.entries(PERMISSION_CATALOG).flatMap(([feature, actions]) =>
    actions.map((action) => `${feature}.${action}`)
  );
}
