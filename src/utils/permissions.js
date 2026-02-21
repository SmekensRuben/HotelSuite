export function hasPermission(user, feature, action) {
  if (!user || !Array.isArray(user.permissions)) return false;

  const normalizedFeature = String(feature || "").trim().toLowerCase();
  const normalizedAction = String(action || "").trim().toLowerCase();

  if (!normalizedFeature || !normalizedAction) return false;

  const permissionKey = `${normalizedFeature}.${normalizedAction}`;
  const wildcardKey = `${normalizedFeature}.*`;

  return user.permissions.some((permission) => {
    const normalizedPermission = String(permission || "").trim().toLowerCase();
    return normalizedPermission === permissionKey || normalizedPermission === wildcardKey;
  });
}
