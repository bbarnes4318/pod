import React from "react";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import CharacterStudio, { StudioHostVM } from "./CharacterStudio";

export const dynamic = "force-dynamic";

function arr(val: unknown): string[] {
  return Array.isArray(val) ? (val as string[]).map(String) : [];
}

export default async function HostsPage() {
  const user = await currentUser(); // the /studio layout already gates sign-in

  // Roster scoping: the user's OWN hosts + shared (ownerId=null) starter hosts —
  // never another account's. Enforced server-side in the query, not just the UI.
  const hosts = await db.aiHost.findMany({
    where: user ? { OR: [{ ownerId: user.id }, { ownerId: null }] } : { ownerId: null },
    orderBy: { createdAt: "asc" },
  });

  const isAdmin = user?.role === "ADMIN";

  const vms: StudioHostVM[] = await Promise.all(
    hosts.map(async (h) => {
      const [episodeCount, segmentCount] = await Promise.all([
        db.episode.count({ where: { hostIds: { has: h.id } } }),
        db.audioSegment.count({ where: { hostId: h.id } }),
      ]);
      const ownedByMe = !!user && h.ownerId === user.id;
      const isShared = h.ownerId === null;
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
        isShared,
        ownedByMe,
        // Only the owner (or an admin) can mutate; shared/others are read-only.
        canEdit: ownedByMe || isAdmin,
      };
    })
  );

  return <CharacterStudio hosts={vms} />;
}
