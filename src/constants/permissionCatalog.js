export const PERMISSION_CATALOG = {
  products: ["view", "create", "edit", "delete"],
};

export function listAllPermissionKeys() {
  return Object.entries(PERMISSION_CATALOG).flatMap(([feature, actions]) =>
    actions.map((action) => `${feature}.${action}`)
  );
}
