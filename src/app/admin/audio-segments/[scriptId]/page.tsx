import React from "react";
import { db } from "@/lib/db";
import { fetchTtsEligibility } from "../actions";
import AudioSegmentsConsole from "./AudioSegmentsConsole";
import { resolveEpisodeHosts } from "@/lib/services/hostCasting";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ scriptId: string }>;
}

export default async function AudioSegmentsDetailPage({ params }: PageProps) {
  const { scriptId } = await params;

  const script = await db.script.findUnique({
    where: { id: scriptId },
    include: {
      episode: true,
      audioSegments: true,
    },
  });

  if (!script) {
    notFound();
  }

  const segments = (script.content as any).segments || [];
  const lines: any[] = [];
  for (let sIdx = 0; sIdx < segments.length; sIdx++) {
    const s = segments[sIdx];
    if (s && Array.isArray(s.lines)) {
      for (const l of s.lines) {
        lines.push({
          lineIndex: l.lineIndex,
          speakerName: l.speakerName,
          speakerHostId: l.speakerHostId,
          text: l.text,
          tone: l.tone,
          // Delivery metadata drives the sound-design stage (reaction SFX,
          // stinger breaks) — surface it so the console tells the whole story.
          energy: l.energy,
          pauseBefore: l.pauseBefore,
          isInterruption: l.isInterruption === true,
          segmentIndex: sIdx,
          segmentType: s.type,
        });
      }
    }
  }

  const latestFactCheck = await db.factCheckResult.findFirst({
    where: { scriptId },
    orderBy: { checkedAt: "desc" },
  });

  const totalLines = lines.length;

  const serializedScript = {
    id: script.id,
    episodeId: script.episodeId,
    episodeTitle: script.episode.title,
    episodeStatus: script.episode.status,
    version: script.version,
    status: script.status,
    latestFactCheckStatus: latestFactCheck ? latestFactCheck.status : "missing",
    totalLines,
    // Default engine if no trigger override is chosen: episode pin, else env.
    provider: script.episode.ttsProvider || process.env.TTS_PROVIDER || "stub",
    lines,
  };

  const initialSegments = script.audioSegments.map((s) => ({
    id: s.id,
    lineIndex: s.lineIndex,
    audioUrl: s.audioUrl,
    durationMs: s.durationMs,
    status: s.status,
    provider: s.provider,
    providerMetadata: s.providerMetadata,
  }));

  const eligibility = await fetchTtsEligibility(scriptId);

  let hosts: Array<{ id: string; slug: string; name: string }> = [];
  try {
    const { hostA, hostB } = await resolveEpisodeHosts({ hostIds: script.episode.hostIds });
    hosts = [hostA, hostB].map((h) => ({ id: h.id, slug: h.slug, name: h.name }));
  } catch {
    hosts = [];
  }

  return (
    <AudioSegmentsConsole
      script={serializedScript}
      initialSegments={initialSegments}
      eligible={!!eligibility.eligible}
      eligibilityReason={eligibility.reason}
      eligibilityWarnings={eligibility.warnings || []}
      hostAId={hosts[0]?.id || ""}
      hostBId={hosts[1]?.id || ""}
      hosts={hosts}
      episodeVoiceOverrides={
        (script.episode.ttsVoiceOverrides as unknown as Record<
          string,
          { provider: string; voiceId: string; voiceName?: string }
        > | null) ?? null
      }
    />
  );
}
