// src/utils/permissions.js
import { ROLE_PERMISSIONS } from '../constants/roles';

export function hasPermission(user, feature, action) {
  if (!user || !user.roles) return false;
  return user.roles.some(role => {
    const featurePerms = ROLE_PERMISSIONS[role]?.[feature] || [];
    return featurePerms.includes(action);
  });
}
