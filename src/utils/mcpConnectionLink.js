/** Only the personal connection pages can survive the login round trip. */
export function mcpConnectionReturnPath(value) {
  if (value === "/settings/connections") return value;
  if (typeof value !== "string") return null;
  return /^\/mcp\/authorize\?requestId=[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
