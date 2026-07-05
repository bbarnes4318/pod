import React from "react";
import { db } from "@/lib/db";
import { accentForSport } from "../accent";
import { emojiForTitle, friendlyStage } from "../lib";
import CreateFlow, { FlowTake, FlowEpisode } from "./CreateFlow";
import VoicePicker from "./VoicePicker";

export const dynamic = "force-dynamic";

const FINISHED = ["audio_ready", "content_ready", "publish_ready", "published"];

function stageIndexFor(status: string): number {
  if (["draft"].includes(status)) return 0;
  if (["script_draft", "script_approved", "fact_checked"].includes(status)) return 1;
  if (["audio_segments_ready", "audio_stitching"].includes(status)) return 2;
  return 3;
}

export default async function CreatePage({ searchParams }: { searchParams: Promise<{ topic?: string }> }) {
  const { topic: highlight } = await searchParams;

  const hosts = await db.aiHost.findMany({
    where: { isActive: true },
    select: { ttsProvider: true },
  }).catch(() => [] as { ttsProvider: string | null }[]);
  const engines = new Set(hosts.map((h) => h.ttsProvider || "default"));
  const currentEngine = engines.size === 1 ? [...engines][0] : "default";

  const [topics, inFlight] = await Promise.all([
    db.topicCandidate.findMany({
      where: { status: { in: ["pending", "approved"] } },
      include: { researchBrief: { select: { id: true } } },
      orderBy: { debateScore: "desc" },
      take: 9,
    }).catch(() => [] as any[]),
    db.episode.findMany({
      where: { status: { notIn: ["failed"] } },
      orderBy: { updatedAt: "desc" },
      take: 6,
    }).catch(() => [] as any[]),
  ]);

  const takes: FlowTake[] = topics.map((t: any) => {
    const a = accentForSport(t.sport, t.title);
    return {
      id: t.id,
      title: t.title,
      sport: t.sport,
      emoji: emojiForTitle(t.title, t.sport),
      status: t.status,
      hasBrief: !!t.researchBrief,
      debateScore: t.debateScore,
      accent: { solid: a.solid, soft: a.soft, tint: a.tint, deep: a.deep },
    };
  });

  const episodes: FlowEpisode[] = inFlight
    .filter((e: any) => !FINISHED.includes(e.status) || !e.audioUrl)
    .concat(inFlight.filter((e: any) => FINISHED.includes(e.status) && e.audioUrl).slice(0, 2))
    .slice(0, 6)
    .map((e: any) => ({
      id: e.id,
      title: e.title,
      status: e.status,
      stageLabel: friendlyStage(e.status).label,
      stageIndex: stageIndexFor(e.status),
      ready: FINISHED.includes(e.status) && !!e.audioUrl,
    }));

  return (
    <>
      <div className="uTopbar">
        <h1 className="uPageTitle">Create an episode</h1>
      </div>
      <div className="uContent" style={{ maxWidth: 980 }}>
        <VoicePicker current={currentEngine} />
        <CreateFlow takes={takes} episodes={episodes} highlight={highlight} />
      </div>
    </>
  );
}
