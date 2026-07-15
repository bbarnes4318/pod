import "server-only";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { verifyAdminAuthHeader } from "./adminBasicAuth";

// Server-side admin gate. proxy.ts challenges and blocks at the network
// boundary; these helpers re-verify inside render/server-function code so a
// proxy matcher change can never silently open the operator surfaces
// (see node_modules/next/dist/docs — "Always verify authentication and
// authorization inside each Server Function").

export async function isAdminRequest(): Promise<boolean> {
  const requestHeaders = await headers();
  return verifyAdminAuthHeader(requestHeaders.get("authorization"));
}

/** For server actions: throws so the action never runs for non-admins. */
export async function requireAdmin(): Promise<void> {
  if (!(await isAdminRequest())) {
    throw new Error("Unauthorized: admin access required");
  }
}

/** For layouts/pages: renders the 404 page for non-admins. */
export async function requireAdminPage(): Promise<void> {
  if (!(await isAdminRequest())) {
    notFound();
  }
}

/** Identity of the authorized operator (the configured admin account) for
 *  audit logging. Only meaningful AFTER `requireAdmin()` has passed. */
export function adminIdentity(): string {
  return process.env.ADMIN_USERNAME || "admin";
}
