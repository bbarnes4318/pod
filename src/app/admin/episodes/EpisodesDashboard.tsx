"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import AdminRundownBuilder from "./AdminRundownBuilder";
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
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Ids removed in THIS session, hidden optimistically until the server list
  // catches up. Deriving the list from props instead of copying it into state
  // keeps the directory in step with every revalidate — a useState copy would
  // pin the first render's list forever.
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const router = useRouter();

  const episodes = initialEpisodes.filter((ep) => !deletedIds.includes(ep.id));

  /**
   * SOFT refresh — deliberately not window.location.reload().
   * The builder reports the backend's final rundown (order, auto-fill labels, a
   * reduced-rundown notice, the audited override) in client state. A hard reload
   * tears the page down and destroys that report the instant it appears, so the
   * operator would never see the outcome of what they just did. router.refresh()
   * re-fetches the server data and leaves client state intact.
   */
  const refreshDashboard = () => {
    router.refresh();
  };

  const handleDelete = async (episodeId: string) => {
    if (!confirm("Are you sure you want to delete this draft episode? All linked topics will revert back to 'approved' status.")) {
      return;
    }

    setDeletingId(episodeId);
    const res = await deleteDraftEpisode(episodeId);

    if (res.success) {
      setDeletedIds((prev) => [...prev, episodeId]);
      router.refresh();
    } else {
      alert(res.error || "Failed to delete episode.");
    }
    setDeletingId(null);
  };

  return (
    <div className="episodesStack">
      {isLlmStub && (
        <p className="stageHint" role="note" data-testid="llm-stub-note">
          LLM_PROVIDER is set to <strong>stub</strong> — generated content will be placeholder text.
        </p>
      )}

      {/* The rundown builder: Manual / Automatic / Hybrid, on the SAME shared
          picker, tray, ordering rules and eligibility contract as Studio. */}
      <AdminRundownBuilder onCreated={refreshDashboard} />

      {/* Existing Episodes List */}
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
