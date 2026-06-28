import React from "react";
import EpisodesDashboard from "./EpisodesDashboard";
import { db } from "@/lib/db";
import "./episodes.css";

// Force Next.js to server-render on demand
export const dynamic = "force-dynamic";

export default async function EpisodesPage() {
  // Fetch episodes along with EpisodeTopic mapping and TopicCandidate details
  const episodesList = await db.episode.findMany({
    include: {
      topics: {
        include: {
          topic: true,
        },
        orderBy: {
          orderIndex: "asc",
        },
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  const serializedEpisodes = episodesList.map((ep) => ({
    id: ep.id,
    title: ep.title,
    slug: ep.slug,
    status: ep.status,
    description: ep.description,
    createdAt: ep.createdAt.toISOString(),
    topics: ep.topics.map((et) => ({
      id: et.topic.id,
      title: et.topic.title,
      debateScore: et.topic.debateScore,
    })),
  }));

  const isLlmStub = process.env.LLM_PROVIDER?.toLowerCase() === "stub";

  return (
    <div className="formContainer" style={{ maxWidth: "100%" }}>
      {/* Header */}
      <div className="episodesHeader">
        <div className="titleGroup">
          <h2>Episode Manager</h2>
          <p>Compile sports debate topics with Research Briefs into draft episodes for podcast distribution.</p>
        </div>
      </div>

      {/* Dashboard */}
      <EpisodesDashboard
        initialEpisodes={serializedEpisodes}
        isLlmStub={isLlmStub}
      />
    </div>
  );
}
