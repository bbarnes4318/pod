// Who may see which rows — ONE definition, used by every owner-scoped surface.
//
// This exists because the rule was previously re-implemented per page and drifted:
//   · /studio/episodes ran a findMany with NO where clause at all, so a brand-new
//     account saw every episode on the deployment under the heading
//     "Everything you've made".
//   · /app/podcasts scoped with `{ OR: [{ownerId: user.id}, {ownerId: null}] }`,
//     which shows every legacy (pre-accounts) podcast to every account that ever
//     signs up — and the detail route rendered its full editable settings wizard.
//
// The rule:
//   · signed out              → nothing (these surfaces are private)
//   · operator (isOwnerAccount: role ADMIN, or an email in OWNER_EMAILS)
//                             → everything, including legacy ownerId=null rows,
//                               which predate accounts and belong to whoever runs
//                               the deployment
//   · everyone else           → strictly rows they own. NOT legacy rows: an
//                               ownerId of null means "nobody claimed this", which
//                               is not the same as "everybody owns this".
//
// Keep `ownerScope` (list filtering) and `canViewOwned` (single-record access) in
// agreement — a row hidden from a list must not be reachable by guessing its URL.

import { isOwnerAccount } from "@/lib/services/entitlementService";

export interface ScopeViewer {
  id: string;
  email?: string | null;
  role?: string | null;
}

/** A Prisma `where` fragment. Spread it into the query's existing where. */
export function ownerScope(user: ScopeViewer | null | undefined): Record<string, unknown> {
  if (!user) return { id: { in: [] as string[] } }; // matches nothing, without throwing
  if (isOwnerAccount(user)) return {};
  return { ownerId: user.id };
}

/** True when this viewer may open a single owned record. Mirrors ownerScope. */
export function canViewOwned(
  user: ScopeViewer | null | undefined,
  record: { ownerId?: string | null } | null | undefined
): boolean {
  if (!user || !record) return false;
  if (isOwnerAccount(user)) return true;
  return !!record.ownerId && record.ownerId === user.id;
}
