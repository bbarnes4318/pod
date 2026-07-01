"use client";

import React, { useState } from "react";
import EpisodeBuildForm from "./EpisodeBuildForm";
import { deleteDraftEpisode } from "./actions";
import Link from "next/link";

interface TopicInfo {
  id: string;
  title: string;
  debateScore: number;
}

interface EpisodeInfo {
  id: string;
  title: string;
  slug: string;
  status: string;
  description: string | null;
  createdAt: string;
  topics: TopicInfo[];
}

interface DashboardProps {
  initialEpisodes: EpisodeInfo[];
  isLlmStub: boolean;
}

export default function EpisodesDashboard({ initialEpisodes, isLlmStub }: DashboardProps) {
  const [episodes, setEpisodes] = useState<EpisodeInfo[]>(initialEpisodes);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const refreshDashboard = () => {
    window.location.reload();
  };

  const handleDelete = async (episodeId: string) => {
    if (!confirm("Are you sure you want to delete this draft episode? All linked topics will revert back to 'approved' status.")) {
      return;
    }

    setDeletingId(episodeId);
    const res = await deleteDraftEpisode(episodeId);

    if (res.success) {
      setEpisodes((prev) => prev.filter((ep) => ep.id !== episodeId));
    } else {
      alert(res.error || "Failed to delete episode.");
    }
    setDeletingId(null);
  };

  return (
    <div className="episodesLayout">
      {/* Left side: Build Controls */}
      <EpisodeBuildForm onBuildSuccess={refreshDashboard} isLlmStub={isLlmStub} />

      {/* Right side: Existing Episodes List */}
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem" }}>
          <h3 style={{ color: "var(--text-primary)", fontSize: "1rem", fontWeight: 700, margin: 0 }}>Episodes Directory</h3>
          <button onClick={refreshDashboard} className="editButton" style={{ fontSize: "0.8rem", padding: "0.25rem 0.75rem" }}>
            Refresh List
          </button>
        </div>

        {episodes.length === 0 ? (
          <div className="emptyState">
            <div className="emptyStateTitle">No episodes found.</div>
            <div className="emptyStateDesc">
              Configure auto-build parameters on the left or select topics manually to assemble your first draft episode.
            </div>
          </div>
        ) : (
          <div className="episodesListCard">
            {episodes.map((ep) => {
              const isDraft = ep.status === "draft" || ep.status === "script_draft";
              const dateStr = new Date(ep.createdAt).toLocaleDateString();

              return (
                <div key={ep.id} className="episodeItem">
                  <div style={{ flexGrow: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.35rem" }}>
                      <span style={{ fontWeight: 700, fontSize: "1.05rem", color: "var(--text-primary)" }}>{ep.title}</span>
                      <span
                        className={`badge ${
                          isDraft
                            ? "badgePending"
                            : ep.status === "completed" || ep.status === "published"
                            ? "badgeCompleted"
                            : "badgeFailed"
                        }`}
                      >
                        {ep.status}
                      </span>
                    </div>

                    <div className="episodeMeta">
                      <span>Created {dateStr}</span>
                      <span>•</span>
                      <span>{ep.topics.length} Debate Topics</span>
                    </div>

                    {ep.description && (
                      <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginTop: "0.5rem", marginBottom: 0 }}>
                        {ep.description}
                      </p>
                    )}

                    {ep.topics.length > 0 && (
                      <div className="episodeTopicList">
                        {ep.topics.map((t, idx) => (
                          <div key={t.id} className="episodeTopicTitle">
                            <span style={{ color: "var(--text-secondary)", marginRight: "0.5rem" }}>#{idx + 1}</span>
                            <span>{t.title}</span>
                            <span style={{ color: "var(--accent-color)", fontFamily: "var(--font-mono)", fontSize: "0.75rem", marginLeft: "0.5rem" }}>
                              (Score: {Math.round(t.debateScore)})
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", minWidth: "120px", alignItems: "flex-end" }}>
                    <Link href={`/admin/episodes/${ep.id}`} className="btnDetails">
                      View Details
                    </Link>

                    {isDraft && (
                      <button
                        onClick={() => handleDelete(ep.id)}
                        disabled={deletingId === ep.id}
                        className="btnReject"
                        style={{ fontSize: "0.75rem", padding: "0.35rem 0.75rem", width: "100%" }}
                      >
                        {deletingId === ep.id ? "Deleting..." : "Delete Draft"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
