// src/utils/permissions.js
import { ROLE_PERMISSIONS } from '../constants/roles';

export function hasPermission(user, feature, action, rolePermissions = {}) {
  if (!user || !user.roles) return false;

  return user.roles.some(role => {
    const roleConfig = rolePermissions[role] || ROLE_PERMISSIONS[role] || {};
    const featurePerms = roleConfig[feature] || [];
    return featurePerms.includes(action);
  });
}
