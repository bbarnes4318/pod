import React from "react";
import { db } from "@/lib/db";
import { fetchTtsEligibility } from "../actions";
import AudioSegmentsConsole from "./AudioSegmentsConsole";
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
  for (const s of segments) {
    if (s && Array.isArray(s.lines)) {
      for (const l of s.lines) {
        lines.push({
          lineIndex: l.lineIndex,
          speakerName: l.speakerName,
          speakerHostId: l.speakerHostId,
          text: l.text,
          tone: l.tone,
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
    provider: process.env.TTS_PROVIDER || "stub",
    lines,
  };

  const initialSegments = script.audioSegments.map((s) => ({
    id: s.id,
    lineIndex: s.lineIndex,
    audioUrl: s.audioUrl,
    durationMs: s.durationMs,
    status: s.status,
  }));

  const eligibility = await fetchTtsEligibility(scriptId);

  const hostA = await db.aiHost.findFirst({ where: { name: "Max Voltage", isActive: true } });
  const hostB = await db.aiHost.findFirst({ where: { name: "Dr. Linebreak", isActive: true } });

  return (
    <AudioSegmentsConsole
      script={serializedScript}
      initialSegments={initialSegments}
      eligible={!!eligibility.eligible}
      eligibilityReason={eligibility.reason}
      hostAId={hostA?.id || ""}
      hostBId={hostB?.id || ""}
    />
  );
}
