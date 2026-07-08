import React from "react";
import { db } from "@/lib/db";
import CharacterStudio, { StudioHostVM } from "./CharacterStudio";

export const dynamic = "force-dynamic";

function arr(val: unknown): string[] {
  return Array.isArray(val) ? (val as string[]).map(String) : [];
}

export default async function HostsPage() {
  const hosts = await db.aiHost.findMany({ orderBy: { createdAt: "asc" } });

  // Reference counts for orphan-protection UX (Episode.hostIds `has` + segments).
  const vms: StudioHostVM[] = await Promise.all(
    hosts.map(async (h) => {
      const [episodeCount, segmentCount] = await Promise.all([
        db.episode.count({ where: { hostIds: { has: h.id } } }),
        db.audioSegment.count({ where: { hostId: h.id } }),
      ]);
      return {
        id: h.id,
        name: h.name,
        role: h.role,
        worldview: h.worldview,
        speakingStyle: h.speakingStyle,
        catchphrases: arr(h.catchphrases),
        boundaries: arr(h.bannedPhrases),
        intensityLevel: h.intensityLevel,
        ttsProvider: h.ttsProvider,
        ttsVoiceId: h.ttsVoiceId,
        voiceSource: h.voiceSource ?? "",
        voiceProvenanceNote: h.voiceProvenanceNote ?? "",
        isActive: h.isActive,
        isArchived: h.isArchived,
        episodeCount,
        segmentCount,
      };
    })
  );

  return <CharacterStudio hosts={vms} />;
}
