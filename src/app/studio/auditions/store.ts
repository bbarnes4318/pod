import "server-only";

// Wiring only. Lives outside actions.ts because every export of a "use server"
// module has to be an async server action, and this is a plain factory that
// both the page and the actions need.

import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { isOwnerAccount } from "@/lib/services/entitlementService";
import {
  createPrismaVoiceAuditionStore,
  type AuditionViewer,
  type VoiceAuditionDeps,
  type VoiceAuditionPrismaClient,
} from "@/lib/services/voiceAudition";

/**
 * The production dependency set: real Prisma persistence, and the default
 * (lazily loaded) TTS renderer, acoustic analyzer and object store.
 *
 * The Prisma delegates are structurally compatible with the narrow port the
 * store declares; the cast keeps the service free of any compile-time
 * dependency on generated client types.
 */
export function auditionDeps(): VoiceAuditionDeps {
  return { store: createPrismaVoiceAuditionStore(db as unknown as VoiceAuditionPrismaClient) };
}

/**
 * The signed-in actor, with "is this an operator?" resolved ONCE, here, by the
 * project's existing rule (`isOwnerAccount`: User.role === "ADMIN", or an email
 * listed in OWNER_EMAILS — the same predicate `getUserPlan` and `ownerScope`
 * use). The audition service takes the resolved flag so there is exactly one
 * definition of "admin" in the app, and so the service stays database-free and
 * therefore testable.
 */
export async function auditionViewer(): Promise<AuditionViewer | null> {
  const user = await currentUser();
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isAdmin: isOwnerAccount(user),
  };
}
