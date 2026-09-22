import 'dotenv/config';

import { PrismaClient } from '@prisma/client';
import { parseHostPerformanceProfileForWrite } from '../lib/hosts/performanceProfile';
import { SPORTS_CHARACTER_PACK } from '../lib/hosts/sportsCharacterPack';

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding " + SPORTS_CHARACTER_PACK.length + " sports characters as INACTIVE catalog entries...");

  for (const character of SPORTS_CHARACTER_PACK) {
    const parsed = parseHostPerformanceProfileForWrite(character.performanceProfile);
    if (!parsed.ok) {
      throw new Error(
        "Invalid performanceProfile for " + character.slug + ":\n" +
          parsed.issues.map((issue) => "  - " + issue).join("\n")
      );
    }

    const existing = await prisma.aiHost.findUnique({
      where: { slug: character.slug },
      select: { ttsProvider: true, ttsVoiceId: true },
    });

    // Preserve a real Fish voice ID once an operator has created and approved
    // one. Re-running this catalog seed must never replace a configured voice
    // with the publish-blocking sentinel.
    const hasConfiguredVoice =
      !!existing?.ttsVoiceId &&
      /^([0-9a-f]{32})$/i.test(existing.ttsVoiceId) &&
      (existing.ttsProvider || "").toLowerCase() === "fish";

    const voiceId = hasConfiguredVoice
      ? existing!.ttsVoiceId
      : character.ttsVoiceId;

    const saved = await prisma.aiHost.upsert({
      where: { slug: character.slug },
      update: {
        name: character.name,
        role: character.role,
        worldview: character.worldview,
        speakingStyle: character.speakingStyle,
        catchphrases: character.catchphrases,
        likes: character.likes,
        dislikes: character.dislikes,
        argumentPatterns: character.argumentPatterns,
        bannedPhrases: character.bannedPhrases,
        ttsProvider: character.ttsProvider,
        ttsVoiceId: voiceId,
        intensityLevel: character.intensityLevel,
        performanceProfile: parsed.profile,
        voiceSource: character.voiceSource,
        voiceProvenanceNote: character.voiceProvenanceNote,
        // Catalog entries stay off the production auto-cast roster until a
        // producer deliberately activates them after voice audition.
        isActive: false,
        isArchived: character.isArchived,
      },
      create: {
        name: character.name,
        slug: character.slug,
        role: character.role,
        worldview: character.worldview,
        speakingStyle: character.speakingStyle,
        catchphrases: character.catchphrases,
        likes: character.likes,
        dislikes: character.dislikes,
        argumentPatterns: character.argumentPatterns,
        bannedPhrases: character.bannedPhrases,
        ttsProvider: character.ttsProvider,
        ttsVoiceId: character.ttsVoiceId,
        intensityLevel: character.intensityLevel,
        performanceProfile: parsed.profile,
        voiceSource: character.voiceSource,
        voiceProvenanceNote: character.voiceProvenanceNote,
        isActive: false,
        isArchived: character.isArchived,
      },
    });

    console.log(
      "  " + character.sport.padEnd(5) + " " + saved.name + " -> " + saved.ttsVoiceId
    );
  }

  console.log(
    "Done. Characters are inactive by design. Create/audition the Fish voices, replace the sentinel IDs, then activate selected hosts in Admin."
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
