export const PERMISSION_CATALOG = {
  super: ["admin"],
  dashboard: ["read"],
  catalogproducts: ["create", "read", "update", "delete"],
  supplierproducts: ["create", "read", "update", "delete"],
  suppliers: ["create", "read", "update", "delete", "password"],
  orders: ["create", "read", "update", "delete", "approve"],
  contracts: ["create", "read", "update", "delete", "notify", "settings"],
  stockcounts: ["create", "read", "update", "delete"],
  settings: ["create", "read", "update", "delete"],
  propertysettings: ["create", "read", "update", "delete"],
  catalogsettings: ["create", "read", "update", "delete"],
  outlets: ["create", "read", "update", "delete"],
  locations: ["create", "read", "update", "delete"],
  imports: ["create", "read", "update", "delete", "execute"],
  integrations: ["create", "read", "update", "delete"],
  notifications: ["create", "read", "update", "delete"],
  reservations: ["read"],
  users: ["create", "read", "update", "delete"],
  auditUpsells: ["read", "settings"],
  groups: ["create", "read", "update", "delete"],
  roominglists: ["create", "read", "update", "approve"],
  demandcalendar: ["create", "read", "update", "delete", "import"],
  groupquotes: ["create", "read", "update", "delete"],
  commercialintelligence: ["create", "read", "update", "delete"],
};

export function listAllPermissionKeys() {
  return Object.entries(PERMISSION_CATALOG).flatMap(([feature, actions]) =>
    actions.map((action) => `${feature}.${action}`)
  );
}
