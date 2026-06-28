import React from "react";
import TopicsDashboard from "./TopicsDashboard";
import { fetchTopicStats } from "./actions";
import { db } from "@/lib/db";
import "./topics.css";

// Force Next.js to server-render on demand
export const dynamic = "force-dynamic";

export default async function TopicsPage() {
  const statsRes = await fetchTopicStats();
  const candidates = await db.topicCandidate.findMany({
    orderBy: { debateScore: "desc" },
  });

  // Serialize models
  const serializedTopics = candidates.map((topic) => ({
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
  }));

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
    <div className="formContainer" style={{ maxWidth: "100%" }}>
      {/* Header */}
      <div className="topicsHeader">
        <div className="titleGroup">
          <h2>Sports Debate Topic Engine</h2>
          <p>Generate debate topic candidates from real database evidence, rank by controversy, and review profiles.</p>
        </div>
      </div>

      {/* Dashboard */}
      <TopicsDashboard
        initialTopics={serializedTopics}
        initialStats={initialStats}
        config={config}
      />
    </div>
  );
}
