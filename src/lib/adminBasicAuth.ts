// Shared verifier for the HTTP Basic Auth that guards the operator surfaces
// (/admin, /studio). Imported by both proxy.ts and server-side code, so it
// must stay dependency-free and use only Web APIs.
//
// Fails closed: when ADMIN_PASSWORD is unset, nothing is authorized.

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length, 1);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i % (ab.length || 1)] ?? 0) ^ (bb[i % (bb.length || 1)] ?? 0);
  }
  return diff === 0;
}

export function verifyAdminAuthHeader(header: string | null): boolean {
  const expectedUsername = process.env.ADMIN_USERNAME || "admin";
  const expectedPassword = process.env.ADMIN_PASSWORD;

  // Fail closed: no configured password means no one gets in.
  if (!expectedPassword) return false;

  if (!header || !header.startsWith("Basic ")) return false;

  let decoded: string;
  try {
    decoded = atob(header.substring(6).trim());
  } catch {
    return false;
  }

  const colonIndex = decoded.indexOf(":");
  if (colonIndex === -1) return false;

  const username = decoded.substring(0, colonIndex);
  const password = decoded.substring(colonIndex + 1);

  const userOk = constantTimeEqual(username, expectedUsername);
  const passOk = constantTimeEqual(password, expectedPassword);
  return userOk && passOk;
}
