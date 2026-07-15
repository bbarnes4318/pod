import React from "react";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { getTopicUsage, resolveTopicReusePolicy } from "@/lib/services/topicUsageService";
import { buildStudioTopicVMs, type RawPoolTopic } from "@/lib/services/studioTopicPool";
import { loadStudioDraft } from "@/lib/services/studioDraft";
import { MAX_TOPICS_PER_EPISODE } from "@/lib/services/episodeCreation";
import RundownBuilder from "./RundownBuilder";

export const dynamic = "force-dynamic";

export default async function CreatePage({ searchParams }: { searchParams: Promise<{ topic?: string }> }) {
  const { topic: seedTopicId } = await searchParams;
  const user = await currentUser(); // /studio layout already gates auth

  // Resume state first — it tells us which podcast to scope usage to.
  const draft = user ? await loadStudioDraft(user.id) : null;

  // Only scope to a podcast the caller actually owns.
  let scopedPodcastId: string | undefined;
  if (user && draft?.podcastId) {
    const pod = await db.podcast.findUnique({ where: { id: draft.podcastId }, select: { ownerId: true } });
    if (pod && (!pod.ownerId || pod.ownerId === user.id || user.role === "ADMIN")) scopedPodcastId = draft.podcastId;
  }

  const [rawTopics, podcasts, hostRows] = await Promise.all([
    db.topicCandidate.findMany({
      where: { status: { in: ["pending", "approved"] } },
      include: { researchBrief: true },
      orderBy: { createdAt: "desc" },
      take: 60,
    }),
    db.podcast.findMany({
      where: user ? { OR: [{ ownerId: user.id }, { ownerId: null }] } : { ownerId: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, verticals: true, teams: true, segmentCount: true, hostIds: true },
    }),
    db.aiHost.findMany({
      where: { isActive: true, isArchived: false, ...(user ? { OR: [{ ownerId: user.id }, { ownerId: null }] } : { ownerId: null }) },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, intensityLevel: true },
    }),
  ]);

  const usage = user
    ? await getTopicUsage(rawTopics.map((t) => t.id), { ownerId: user.id, podcastId: scopedPodcastId })
    : new Map();
  const policy = resolveTopicReusePolicy();
  const topics = buildStudioTopicVMs(rawTopics as unknown as RawPoolTopic[], { usage, policy, podcastId: scopedPodcastId })
    .sort((a, b) => b.talkability - a.talkability);

  const hosts = hostRows.map((h) => ({ id: h.id, name: h.name, intensity: h.intensityLevel }));

  return (
    <div className="fadeUp">
      <h1 className="pageTitle">Build a rundown</h1>
      <p className="pageSub">
        Line up the takes, set the order, cast the hosts — a full sports-newsroom rundown. Manual, automatic, or a hybrid of both.
      </p>
      <RundownBuilder
        podcasts={podcasts}
        initialTopics={topics}
        hosts={hosts}
        initialDraft={draft}
        maxTopics={MAX_TOPICS_PER_EPISODE}
        seedTopicId={seedTopicId ?? null}
      />
    </div>
  );
}
