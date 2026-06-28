import React from "react";
import EpisodeDetailView from "./EpisodeDetailView";
import { db } from "@/lib/db";
import "../episodes.css";
import { notFound } from "next/navigation";

// Force Next.js to server-render on demand
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EpisodeDetailPage({ params }: PageProps) {
  const { id } = await params;

  // Load the episode details along with ordered topics and briefs
  const ep = await db.episode.findUnique({
    where: { id },
    include: {
      topics: {
        include: {
          topic: {
            include: {
              researchBrief: true,
            },
          },
        },
        orderBy: {
          orderIndex: "asc",
        },
      },
    },
  });

  if (!ep) {
    notFound();
  }

  // Load previous scripts versions
  const scriptRecords = await db.script.findMany({
    where: { episodeId: ep.id },
    orderBy: { version: "desc" },
  });

  const allAudioSegments = await db.audioSegment.findMany({
    where: { episodeId: ep.id },
  });

  const serializedScripts = scriptRecords.map((s) => {
    const segments = allAudioSegments.filter((a) => a.scriptId === s.id);
    const readyCount = segments.filter((a) => a.status === "ready").length;
    const failedCount = segments.filter((a) => a.status === "failed").length;
    const totalLines = Array.isArray((s.content as any)?.segments)
      ? (s.content as any).segments.reduce((acc: number, seg: any) => acc + (seg.lines?.length || 0), 0)
      : 0;

    return {
      id: s.id,
      version: s.version,
      status: s.status,
      plainText: s.plainText,
      createdAt: s.createdAt.toISOString(),
      audioSegments: {
        totalLines,
        readyCount,
        failedCount,
      },
    };
  });

  const serializedEpisode = {
    id: ep.id,
    title: ep.title,
    slug: ep.slug,
    status: ep.status,
    description: ep.description,
    audioUrl: ep.audioUrl,
    transcriptUrl: ep.transcriptUrl,
    longShowNotes: ep.longShowNotes,
    durationSeconds: ep.durationSeconds,
    createdAt: ep.createdAt.toISOString(),
    topics: ep.topics.map((et) => {
      const t = et.topic;
      const b = t.researchBrief;

      return {
        id: t.id,
        title: t.title,
        sport: t.sport,
        leagueId: t.leagueId,
        summary: t.summary,
        debateScore: t.debateScore,
        evidenceIds: t.evidenceIds,
        brief: b
          ? {
              facts: b.facts,
              stats: b.stats,
              injuryContext: b.injuryContext,
              oddsContext: b.oddsContext,
              argumentForHostA: b.argumentForHostA,
              argumentForHostB: b.argumentForHostB,
              counterArguments: b.counterArguments,
              unsafeClaims: b.unsafeClaims,
              sourceIds: b.sourceIds,
            }
          : null,
      };
    }),
  };

  const factCheckRecords = await db.factCheckResult.findMany({
    where: { episodeId: ep.id },
    orderBy: { checkedAt: "desc" },
  });

  const serializedFactChecks = factCheckRecords.map((f) => ({
    id: f.id,
    scriptId: f.scriptId,
    status: f.status,
    checkedAt: f.checkedAt.toISOString(),
  }));

  return (
    <div className="formContainer" style={{ maxWidth: "100%" }}>
      <EpisodeDetailView
        episode={serializedEpisode}
        initialScripts={serializedScripts}
        initialFactChecks={serializedFactChecks}
      />
    </div>
  );
}
