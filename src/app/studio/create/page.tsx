import React from "react";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { scoreTopicTalkability } from "@/lib/services/talkabilityService";
import { FINISHED_STATUSES } from "../lib";
import CreateConsole, { StepperTake, StepperHost, ResumeEpisode } from "./CreateConsole";

export const dynamic = "force-dynamic";

export default async function CreatePage({ searchParams }: { searchParams: Promise<{ topic?: string }> }) {
  const { topic: highlightTopic } = await searchParams;
  const user = await currentUser(); // layout already gates /studio; used here for resume scoping

  const [topics, hosts, resume] = await Promise.all([
    db.topicCandidate.findMany({
      where: { status: { in: ["pending", "approved"] } },
      include: { researchBrief: true },
      orderBy: { debateScore: "desc" },
      take: 12,
    }),
    db.aiHost.findMany({
      where: { isActive: true },
      orderBy: { intensityLevel: "desc" },
      select: { id: true, name: true, intensityLevel: true },
    }),
    // The creator's own most-recent unfinished episode — lets the stepper
    // resume mid-pipeline instead of starting over.
    user
      ? db.episode.findFirst({
          where: { ownerId: user.id, status: { notIn: [...FINISHED_STATUSES, "failed", "published"] } },
          orderBy: { updatedAt: "desc" },
          select: {
            id: true,
            title: true,
            status: true,
            topics: { orderBy: { orderIndex: "asc" }, take: 1, select: { topicId: true } },
          },
        })
      : Promise.resolve(null),
  ]);

  const takes: StepperTake[] = topics
    .map((t) => {
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
        heat: talk.total,
      };
    })
    .sort((a, b) => b.heat - a.heat);

  const hostOptions: StepperHost[] = hosts.map((h) => ({ id: h.id, name: h.name, intensity: h.intensityLevel }));

  const resumeEp: ResumeEpisode | null = resume
    ? { id: resume.id, title: resume.title, status: resume.status, topicId: resume.topics[0]?.topicId ?? null }
    : null;

  return (
    <div className="fadeUp">
      <h1 className="pageTitle">Create</h1>
      <p className="pageSub">
        One take in, one episode out — research, script, voices, mix. Review before the studio spends on voices.
      </p>
      <CreateConsole takes={takes} hosts={hostOptions} highlightTopic={highlightTopic} resume={resumeEp} />
    </div>
  );
}
