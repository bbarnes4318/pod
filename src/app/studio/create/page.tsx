import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { getTopicUsage, resolveTopicReusePolicy } from "@/lib/services/topicUsageService";
import { buildStudioTopicVMs, type RawPoolTopic } from "@/lib/services/studioTopicPool";
import { loadStudioDraft } from "@/lib/services/studioDraft";
import { getStudioPodcastsFor, type StudioCtx } from "@/lib/services/studioActions";
import { MAX_TOPICS_PER_EPISODE } from "@/lib/services/episodeCreation";
import type { PrismaClient } from "@prisma/client";
import RundownBuilder from "./RundownBuilder";
import { ttsEngineOptions } from "@/lib/providers/tts/availability";
import { AppPage, PageHeader } from "@/components/studio";

export const dynamic = "force-dynamic";

export default async function CreatePage({ searchParams }: { searchParams: Promise<{ topic?: string }> }) {
  const { topic: seedTopicId } = await searchParams;
  const user = await currentUser();
  const draft = user ? await loadStudioDraft(user.id) : null;
  let scopedPodcastId: string | undefined;
  if (user && draft?.podcastId) {
    const pod = await db.podcast.findUnique({ where: { id: draft.podcastId }, select: { ownerId: true } });
    if (pod && (pod.ownerId === user.id || user.role === "ADMIN")) scopedPodcastId = draft.podcastId;
  }
  const podcastsRes = user ? await getStudioPodcastsFor({ user: { id: user.id, role: user.role }, db: db as unknown as PrismaClient } as StudioCtx) : { podcasts: [] };
  const [rawTopics, hostRows] = await Promise.all([
    db.topicCandidate.findMany({ where: { status: { in: ["pending", "approved"] } }, include: { researchBrief: true }, orderBy: { createdAt: "desc" }, take: 60 }),
    db.aiHost.findMany({ where: { isActive: true, isArchived: false, ...(user ? { OR: [{ ownerId: user.id }, { ownerId: null }] } : { ownerId: null }) }, orderBy: { createdAt: "desc" }, select: { id: true, name: true, intensityLevel: true } }),
  ]);
  const usage = user ? await getTopicUsage(rawTopics.map(topic => topic.id), { ownerId: user.id, podcastId: scopedPodcastId }) : new Map();
  const topics = buildStudioTopicVMs(rawTopics as unknown as RawPoolTopic[], { usage, policy: resolveTopicReusePolicy(), podcastId: scopedPodcastId }).sort((a, b) => b.talkability - a.talkability);
  const hosts = hostRows.map(host => ({ id: host.id, name: host.name, intensity: host.intensityLevel }));

  return <AppPage><PageHeader title="Create an episode" description="Choose the show, build the rundown, confirm the cast and production profile, then start the real generation pipeline." /><div className="createProductionWorkspace"><RundownBuilder podcasts={podcastsRes.podcasts} initialTopics={topics} hosts={hosts} initialDraft={draft} maxTopics={MAX_TOPICS_PER_EPISODE} seedTopicId={seedTopicId ?? null} ttsEngines={ttsEngineOptions()} /></div></AppPage>;
}
