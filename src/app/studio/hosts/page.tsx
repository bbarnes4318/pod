import React from "react";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { settingsFromHost } from "@/lib/hosts/hostStudioProfile";
import CharacterStudio, { type StudioHostVM } from "./CharacterStudio";

export const dynamic = "force-dynamic";

function arr(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]).map(String) : [];
}

export default async function HostsPage() {
  const user = await currentUser();
  const hosts = await db.aiHost.findMany({
    where: user ? { OR: [{ ownerId: user.id }, { ownerId: null }] } : { ownerId: null },
    orderBy: { createdAt: "asc" },
  });
  const isAdmin = user?.role === "ADMIN";

  const vms: StudioHostVM[] = await Promise.all(hosts.map(async (host) => {
    const [episodeCount, segmentCount] = await Promise.all([
      db.episode.count({ where: { hostIds: { has: host.id } } }),
      db.audioSegment.count({ where: { hostId: host.id } }),
    ]);
    const ownedByMe = !!user && host.ownerId === user.id;
    return {
      id: host.id,
      name: host.name,
      role: host.role,
      worldview: host.worldview,
      speakingStyle: host.speakingStyle,
      catchphrases: arr(host.catchphrases),
      boundaries: arr(host.bannedPhrases),
      argumentPatterns: arr(host.argumentPatterns),
      settings: settingsFromHost({
        role: host.role,
        worldview: host.worldview,
        speakingStyle: host.speakingStyle,
        intensityLevel: host.intensityLevel,
        argumentPatterns: host.argumentPatterns,
        bannedPhrases: host.bannedPhrases,
        catchphrases: host.catchphrases,
        performanceProfile: host.performanceProfile,
      }),
      ttsProvider: host.ttsProvider,
      ttsVoiceId: host.ttsVoiceId,
      voiceSource: host.voiceSource ?? "",
      voiceProvenanceNote: host.voiceProvenanceNote ?? "",
      isActive: host.isActive,
      isArchived: host.isArchived,
      episodeCount,
      segmentCount,
      isShared: host.ownerId === null,
      ownedByMe,
      canEdit: ownedByMe || isAdmin,
    };
  }));

  return <CharacterStudio hosts={vms} />;
}
