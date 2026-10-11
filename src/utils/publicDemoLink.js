// Public presentation configuration; never a credential or authentication endpoint.
export function publicDemoLink({ url = "", email = "" } = {}) {
  if (typeof url === "string" && url.trim()) {
    try {
      const parsed = new URL(url.trim());
      if (parsed.protocol === "https:" && !parsed.username && !parsed.password)
        return parsed.href;
    } catch {
      /* An invalid optional URL must not create an unsafe link. */
    }
  }
  if (
    typeof email === "string" &&
    /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)
  ) {
    return `mailto:${email}?subject=Hotel%20Toolkit%20demo`;
  }
  return null;
}
