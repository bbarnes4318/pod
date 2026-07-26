import { PrismaClient } from "@prisma/client";
import { parseHostPerformanceProfileForWrite } from "../src/lib/hosts/performanceProfile";
import {
  PLACEHOLDER_VOICE_ID,
  RETIRED_HOST_SLUGS,
  SEED_HOSTS,
  resolveSeatAVoice,
  resolveSeatBVoice,
} from "../src/lib/hosts/roster";

const prisma = new PrismaClient();

// The roster itself lives in src/lib/hosts/roster.ts so the character contracts
// can be asserted without standing up a database. This file is the WRITER: it
// resolves voices against what is already stored, validates, upserts by slug,
// and retires previous rosters.

async function main() {
  console.log("Seeding AI Host personalities (Host Bible v5 — the customer and the witness)...");

  const hosts = SEED_HOSTS.map((h) => ({ ...h }));

  // Voices are resolved against whatever is already on the row, so a reseed
  // preserves a configured voice instead of clobbering it with the
  // publish-blocking placeholder. See resolveSeatBVoice for the full order.
  hosts[0].ttsVoiceId = resolveSeatAVoice();
  const existingCal = await prisma.aiHost.findUnique({
    where: { slug: hosts[1].slug },
    select: { ttsVoiceId: true },
  });
  const seatB = resolveSeatBVoice(existingCal?.ttsVoiceId);
  hosts[1].ttsVoiceId = seatB.voiceId;
  if (seatB.warning) console.warn(seatB.warning);
  console.log(`Seat B voice: ${seatB.source}.`);

  // WRITE-TIME VALIDATION. An invalid performanceProfile must be impossible to
  // store, because the runtime resolver falls back to a DERIVED profile on a
  // parse failure — which silently discards the authored performance and can
  // invert a character wholesale (one bad enum string turned a host who opens
  // at full volume into a quiet, rarely-laughing, rarely-interrupting one, with
  // nothing logged). Failing here means the runtime fallback only ever has to
  // handle genuinely ABSENT profiles.
  for (const host of hosts) {
    const parsed = parseHostPerformanceProfileForWrite(host.performanceProfile);
    if (!parsed.ok) {
      throw new Error(
        `Seed aborted: performanceProfile for '${host.slug}' is invalid and would be silently replaced by a derived one at runtime.\n` +
          parsed.issues.map((i) => `  - ${i}`).join("\n")
      );
    }
  }

  for (const host of hosts) {
    const upserted = await prisma.aiHost.upsert({
      where: { slug: host.slug },
      update: host,
      create: host,
    });
    const placeholder = upserted.ttsVoiceId === PLACEHOLDER_VOICE_ID ? "  [PLACEHOLDER VOICE — publishing is blocked]" : "";
    console.log(`Upserted AI Host: ${upserted.name} (${upserted.slug})${placeholder}`);
  }

  // Retire every previous roster. updateMany matches zero rows on a fresh
  // database, so this is a no-op there and idempotent on every later run.
  //
  // isArchived alone is the correct retirement, and isActive MUST stay true.
  // resolveEpisodeCast (hostCasting.ts) reads the two flags differently:
  // a PINNED hostId is looked up with `isActive: true` only, while the
  // auto-fill roster additionally requires `isArchived: false`. Archiving
  // therefore removes a host from pickers and auto-casting while episodes
  // that pinned them still resolve. Deactivating would drop the pinned
  // lookup, and those episodes would fall through to auto-fill and silently
  // re-cast themselves with the current roster.
  const retired = await prisma.aiHost.updateMany({
    where: { slug: { in: RETIRED_HOST_SLUGS } },
    data: { isArchived: true },
  });
  if (retired.count > 0) console.log(`Archived ${retired.count} retired host(s): ${RETIRED_HOST_SLUGS.join(", ")}.`);

  console.log("Seeding static Leagues...");
  const leagues = [
    { id: "NFL", name: "National Football League", sport: "Football", slug: "nfl", isActive: true },
    { id: "NBA", name: "National Basketball Association", sport: "Basketball", slug: "nba", isActive: true },
    { id: "MLB", name: "Major League Baseball", sport: "Baseball", slug: "mlb", isActive: true },
    { id: "NCAAF", name: "NCAA Football", sport: "Football", slug: "ncaaf", isActive: true },
    { id: "NCAAB", name: "NCAA Basketball", sport: "Basketball", slug: "ncaab", isActive: true },
    { id: "MMA", name: "Mixed Martial Arts", sport: "Combat Sports", slug: "mma", isActive: true },
  ];

  for (const league of leagues) {
    const upserted = await prisma.league.upsert({
      where: { id: league.id },
      update: league,
      create: league,
    });
    console.log(`Upserted League: ${upserted.name} (${upserted.id})`);
  }

  console.log("Seeding completed successfully.");
}

main()
  .catch((e) => {
    console.error("Error during seed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

export { PLACEHOLDER_VOICE_ID };
