import "server-only";

// Wiring only. Lives outside actions.ts because every export of a "use server"
// module has to be an async server action, and this is a plain factory that
// both the page and the actions need.

import { db } from "@/lib/db";
import {
  createPrismaVoiceAuditionStore,
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
