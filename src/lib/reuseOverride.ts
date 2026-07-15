// Shared constant for the admin reuse-override flow. Kept out of the
// "use server" actions module (which may only export async functions) so both
// the server action and the client form can import it.

/** Confirmation the Admin UI must show before authorizing a reuse override. */
export const REUSE_OVERRIDE_CONFIRMATION =
  "This topic was recently used by this podcast. Reuse it anyway?";
