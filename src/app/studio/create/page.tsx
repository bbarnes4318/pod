import React from "react";
import { db } from "@/lib/db";
import { scoreTopicTalkability } from "@/lib/services/talkabilityService";
import { nextActionFor, statusChip, FINISHED_STATUSES } from "../lib";
import CreateConsole from "./CreateConsole";

export const dynamic = "force-dynamic";

export default async function CreatePage({ searchParams }: { searchParams: Promise<{ topic?: string }> }) {
  const { topic: highlightTopic } = await searchParams;

  const [topics, inFlight] = await Promise.all([
    db.topicCandidate.findMany({
      where: { status: { in: ["pending", "approved"] } },
      include: { researchBrief: true },
      orderBy: { debateScore: "desc" },
      take: 8,
    }),
    db.episode.findMany({
      where: { status: { notIn: [...FINISHED_STATUSES, "failed"] } },
      orderBy: { updatedAt: "desc" },
      take: 5,
      include: { scripts: { orderBy: { version: "desc" }, take: 1, select: { id: true } } },
    }),
  ]);

  const takes = topics.map((t) => {
    const talk = scoreTopicTalkability({
      title: t.title,
      summary: t.summary,
      createdAt: t.createdAt,
      brief: t.researchBrief as any,
    });
    return {
      id: t.id,
      title: t.title,
      sport: t.sport,
      status: t.status,
      hasBrief: !!t.researchBrief,
      talkability: talk.total,
      scores: [
        { label: "Controversy", value: t.controversyScore },
        { label: "Star power", value: t.starPowerScore },
        { label: "Betting heat", value: t.bettingRelevanceScore },
        { label: "Freshness", value: t.recencyScore },
      ],
    };
  }).sort((a, b) => b.talkability - a.talkability);

  const episodes = inFlight.map((ep) => {
    const action = nextActionFor(ep, ep.scripts[0]?.id);
    return {
      id: ep.id,
      title: ep.title,
      status: ep.status,
      statusLabel: statusChip(ep.status).label,
      scriptId: ep.scripts[0]?.id ?? null,
      nextLabel: action.label,
      nextHref: action.href,
    };
  });

  return (
    <div className="fadeUp">
      <h1 className="pageTitle">Create</h1>
      <p className="pageSub">
        One take in, one episode out. Pick the story, and each card walks you through the single next step —
        research, script, voices, mix, publish.
      </p>
      <CreateConsole takes={takes} episodes={episodes} highlightTopic={highlightTopic} />
    </div>
  );
}
