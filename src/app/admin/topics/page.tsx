import React from "react";
import TopicsDashboard from "./TopicsDashboard";
import { fetchTopicStats } from "./actions";
import { db } from "@/lib/db";
import "./topics.css";

// Force Next.js to server-render on demand
export const dynamic = "force-dynamic";

export default async function TopicsPage() {
  const statsRes = await fetchTopicStats();

  // Load every candidate WITH its real consumption trail:
  //   TopicCandidate.episodeTopics[] → Episode → Podcast
  // (the EpisodeTopic join is the only place the topic→episode→podcast link is
  // stored). A topic with ≥1 episodeTopics has been USED to build an episode;
  // the rest are UNUSED and still available to draft from.
  const candidates = await db.topicCandidate.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      episodeTopics: {
        include: {
          episode: {
            select: {
              id: true,
              title: true,
              status: true,
              publishedAt: true,
              podcast: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
  });

  const serializedTopics = candidates.map((topic) => {
    const usages = topic.episodeTopics
      .filter((et) => et.episode)
      .map((et) => ({
        episodeId: et.episode.id,
        episodeTitle: et.episode.title,
        episodeStatus: et.episode.status,
        episodePublishedAt: et.episode.publishedAt ? et.episode.publishedAt.toISOString() : null,
        podcastId: et.episode.podcast?.id ?? null,
        podcastName: et.episode.podcast?.name ?? null,
      }));
    return {
      id: topic.id,
      title: topic.title,
      sport: topic.sport,
      leagueId: topic.leagueId,
      summary: topic.summary,
      controversyScore: topic.controversyScore,
      starPowerScore: topic.starPowerScore,
      bettingRelevanceScore: topic.bettingRelevanceScore,
      recencyScore: topic.recencyScore,
      debateScore: topic.debateScore,
      evidenceIds: topic.evidenceIds,
      status: topic.status,
      createdAt: topic.createdAt.toISOString(),
      usages,
      used: usages.length > 0,
    };
  });

  const initialStats = statsRes.success && statsRes.stats ? statsRes.stats : {
    evidenceCount: 0,
    pendingCount: 0,
    approvedCount: 0,
    rejectedCount: 0,
  };

  const config = {
    llmProvider: process.env.LLM_PROVIDER || "stub",
    sportsProvider: process.env.SPORTS_PROVIDER || "stub",
    hasRealIngestedEvidence: initialStats.evidenceCount > 0,
  };

  return (
    <div className="topicsPage">
      <TopicsDashboard
        initialTopics={serializedTopics}
        initialStats={initialStats}
        config={config}
      />
    </div>
  );
}
