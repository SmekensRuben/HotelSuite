// src/utils/permissions.js
import { ROLE_PERMISSIONS } from '../constants/roles';

export function hasPermission(user, feature, action, rolePermissions = {}) {
  if (!user || !user.roles) return false;

  const normalizedFeature = String(feature || "").trim().toLowerCase();
  const normalizedAction = String(action || "").trim().toLowerCase();

  return user.roles.some(role => {
    const roleKey = String(role || "").trim();
    const normalizedRoleKey = roleKey.toLowerCase();

    const roleConfig =
      rolePermissions[roleKey] ||
      rolePermissions[normalizedRoleKey] ||
      ROLE_PERMISSIONS[roleKey] ||
      ROLE_PERMISSIONS[normalizedRoleKey] ||
      {};

    const featurePerms = roleConfig[normalizedFeature] || roleConfig[feature] || [];
    return featurePerms.includes(normalizedAction) || featurePerms.includes(action);
  });
}
