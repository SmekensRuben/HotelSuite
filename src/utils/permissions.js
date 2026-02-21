function normalizePermissionAction(action) {
  const normalized = String(action || "").trim().toLowerCase();

  if (normalized === "view") return "read";
  if (normalized === "edit") return "update";

  return normalized;
}

export function hasPermission(user, feature, action) {
  if (!user || !Array.isArray(user.permissions)) return false;

  const normalizedFeature = String(feature || "").trim().toLowerCase();
  const normalizedAction = normalizePermissionAction(action);

  if (!normalizedFeature || !normalizedAction) return false;

  const permissionKey = `${normalizedFeature}.${normalizedAction}`;
  const wildcardKey = `${normalizedFeature}.*`;

  return user.permissions.some((permission) => {
    const [permissionFeature, permissionAction] = String(permission || "")
      .trim()
      .toLowerCase()
      .split(".");

    if (!permissionFeature || !permissionAction) return false;

    const normalizedPermissionKey = `${permissionFeature}.${normalizePermissionAction(
      permissionAction
    )}`;

    return normalizedPermissionKey === permissionKey || normalizedPermissionKey === wildcardKey;
  });
}
