// Post-login redirect allowlist. Both the /app listener portal and the
// /studio creator surface authenticate through the same NextAuth session, so a
// login started from either place must be allowed to return there. Everything
// else falls back to a safe default — never an open redirect (only same-origin,
// non-protocol-relative paths under a known prefix are accepted).

const ALLOWED_PREFIXES = ["/app", "/studio"] as const;

export function safeCallbackUrl(
  raw: string | string[] | null | undefined,
  fallback = "/app"
): string {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string") return fallback;
  // Reject protocol-relative ("//evil.com") and absolute URLs implicitly:
  // both fail the single-leading-slash prefix test below.
  return ALLOWED_PREFIXES.some((p) => v === p || v.startsWith(p + "/") || v.startsWith(p + "?"))
    ? v
    : fallback;
}
