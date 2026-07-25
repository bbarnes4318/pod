// One-shot production migration to the Host Bible v2 roster.
// Run (in the deployed container): npm run hosts:migrate-v2
//
// What it does — additive and reversible:
//   1. Upserts Bernadette "Line Two" Zabala (seat A, intensity 8) and
//      Otis "Laminate" Kemp (seat B, intensity 6), with validated
//      performance profiles (opposite anger signatures) and provenance notes.
//   2. ARCHIVES every other currently-active host (Louie/Margo, and any
//      legacy Max Voltage / Dr. Linebreak rows): isArchived=true, isActive
//      KEPT true — archived hosts drop out of pickers and auto-casting but
//      episodes that pinned them keep resolving their cast, so old episodes
//      re-render identically.
//   3. Prints the resulting active roster.
//
// Voice ids: set FISH_ZABALA_VOICE_ID / FISH_KEMP_VOICE_ID (32-hex Fish
// reference ids) before running to bind the blended voices. Without them the
// previous roster's gender-matched working voices are reused so production
// keeps shipping; re-run the script after creating the real voices.

import { execSync } from "node:child_process";

async function main() {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
    const before = await prisma.aiHost.findMany({
      where: { isActive: true, isArchived: false },
      select: { slug: true, name: true, intensityLevel: true },
    });
    console.log("Active roster before:", before.map((h) => `${h.name} (${h.slug}, ${h.intensityLevel})`).join(" | ") || "(none)");

    // Reuse the seed's single source of truth by running it: seed.ts upserts
    // the v2 pair and archives louie/margo. Then archive ANY other active
    // host that isn't the v2 pair (covers older rosters).
    console.log("\nRunning prisma seed (upserts v2 hosts, archives previous pair)...");
    execSync("npx prisma db seed", { stdio: "inherit" });

    const archivedOthers = await prisma.aiHost.updateMany({
      where: { slug: { notIn: ["bernie-line-two", "otis-laminate"] }, isArchived: false },
      data: { isArchived: true },
    });
    if (archivedOthers.count > 0) {
      console.log(`Archived ${archivedOthers.count} additional non-v2 host(s) (kept active for their existing episodes).`);
    }

    const after = await prisma.aiHost.findMany({
      where: { isActive: true, isArchived: false },
      orderBy: { intensityLevel: "desc" },
      select: { slug: true, name: true, intensityLevel: true, ttsProvider: true, ttsVoiceId: true },
    });
    console.log("\nActive roster after:");
    for (const h of after) {
      console.log(`  ${h.name} — slug=${h.slug} intensity=${h.intensityLevel} engine=${h.ttsProvider} voice=${h.ttsVoiceId.slice(0, 8)}…`);
    }
    if (after.length !== 2 || after[0].slug !== "bernie-line-two" || after[1].slug !== "otis-laminate") {
      console.warn("\nWARNING: expected exactly Zabala (seat A) + Kemp (seat B) as the active roster — review /admin/personalities.");
      process.exitCode = 1;
    } else {
      console.log("\nHost Bible v2 roster is live. New episodes auto-cast Zabala (A) vs Kemp (B); archived hosts keep voicing their old episodes.");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
