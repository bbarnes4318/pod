"use client";

import React, { useState } from "react";
import TopicGenerationForm from "./TopicGenerationForm";
import { approveTopic, rejectTopic, resetTopicToPending, fetchTopicStats } from "./actions";

interface Topic {
  id: string;
  title: string;
  sport: string;
  leagueId: string | null;
  summary: string | null;
  controversyScore: number;
  starPowerScore: number;
  bettingRelevanceScore: number;
  recencyScore: number;
  debateScore: number;
  evidenceIds: any;
  status: string;
  createdAt: string;
}

interface DashboardProps {
  initialTopics: Topic[];
  initialStats: {
    evidenceCount: number;
    pendingCount: number;
    approvedCount: number;
    rejectedCount: number;
  };
  config: {
    llmProvider: string;
    sportsProvider: string;
    hasRealIngestedEvidence: boolean;
  };
}

export default function TopicsDashboard({ initialTopics, initialStats, config }: DashboardProps) {
  const [topics, setTopics] = useState<Topic[]>(initialTopics);
  const [stats, setStats] = useState(initialStats);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const isLlmStub = config.llmProvider.toLowerCase() === "stub";
  const isSportsStub = config.sportsProvider.toLowerCase() === "stub";
  const hasNoEvidence = !config.hasRealIngestedEvidence && stats.evidenceCount === 0;

  const refreshData = async () => {
    const statsRes = await fetchTopicStats();
    if (statsRes.success && statsRes.stats) {
      setStats(statsRes.stats);
    }
    window.location.reload();
  };

  const handleApprove = async (id: string) => {
    setLoadingId(id);
    const res = await approveTopic(id);
    if (res.success) {
      setTopics(prev =>
         prev.map(t => (t.id === id ? { ...t, status: "approved" } : t))
      );
      setStats(prev => ({
        ...prev,
        pendingCount: Math.max(0, prev.pendingCount - 1),
        approvedCount: prev.approvedCount + 1,
      }));
    } else {
      alert(res.error || "Failed to approve topic");
    }
    setLoadingId(null);
  };

  const handleReject = async (id: string) => {
    setLoadingId(id);
    const res = await rejectTopic(id);
    if (res.success) {
      setTopics(prev =>
        prev.map(t => (t.id === id ? { ...t, status: "rejected" } : t))
      );
      setStats(prev => ({
        ...prev,
        pendingCount: Math.max(0, prev.pendingCount - 1),
        rejectedCount: prev.rejectedCount + 1,
      }));
    } else {
      alert(res.error || "Failed to reject topic");
    }
    setLoadingId(null);
  };

  const handleReset = async (id: string) => {
    setLoadingId(id);
    const res = await resetTopicToPending(id);
    if (res.success) {
      setTopics(prev =>
        prev.map(t => (t.id === id ? { ...t, status: "pending" } : t))
      );
      refreshData();
    } else {
      alert(res.error || "Failed to reset topic status");
    }
    setLoadingId(null);
  };

  const getArray = (val: any): any[] => {
    if (Array.isArray(val)) return val;
    return [];
  };

  return (
    <div>
      {/* 1. WARNING BANNERS */}
      {isLlmStub && (
        <div className="alertCard alertDanger">
          <strong>⚠️ LLM provider is stub. Real topic generation disabled.</strong>
          <p style={{ marginTop: "0.25rem", opacity: 0.9 }}>
            The application is configured with <code>LLM_PROVIDER=stub</code>. The stub LLM does not generate fake debate topics to comply with our safety specification. To generate real debate topics, configure a real LLM provider (OpenAI or Anthropic) in your environment variables.
          </p>
        </div>
      )}

      {hasNoEvidence && (
        <div className="alertCard alertWarning">
          <strong>⚠️ No real sports evidence available. Ingest real sports data before generating topics.</strong>
          <p style={{ marginTop: "0.25rem", opacity: 0.9 }}>
            There are no sports records (games, news, injuries, stats) in the database. Static leagues do not count as evidence. You must run data ingestion first to capture real sports data before the Topic Engine can run.
          </p>
        </div>
      )}

      {isSportsStub && !hasNoEvidence && (
        <div className="alertCard alertWarning" style={{ opacity: 0.85 }}>
          <strong>ℹ️ Stub Sports Provider Active</strong>
          <p style={{ marginTop: "0.25rem", opacity: 0.9 }}>
            The sports data provider is currently set to stub. New ingestion is disabled, but you can generate topics using any existing real database evidence records.
          </p>
        </div>
      )}

      {/* 2. STATS SUMMARY BAR */}
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", marginBottom: "2rem" }}>
        <div className="card" style={{ padding: "1.25rem" }}>
          <div className="cardTitle" style={{ fontSize: "0.75rem" }}>Evidence Count</div>
          <div className="cardValue" style={{ fontSize: "1.6rem" }}>{stats.evidenceCount}</div>
        </div>
        <div className="card" style={{ padding: "1.25rem" }}>
          <div className="cardTitle" style={{ fontSize: "0.75rem", color: "var(--warning-color)" }}>Pending Candidates</div>
          <div className="cardValue" style={{ fontSize: "1.6rem", color: "var(--warning-color)" }}>{stats.pendingCount}</div>
        </div>
        <div className="card" style={{ padding: "1.25rem" }}>
          <div className="cardTitle" style={{ fontSize: "0.75rem", color: "var(--success-color)" }}>Approved Topics</div>
          <div className="cardValue" style={{ fontSize: "1.6rem", color: "var(--success-color)" }}>{stats.approvedCount}</div>
        </div>
        <div className="card" style={{ padding: "1.25rem" }}>
          <div className="cardTitle" style={{ fontSize: "0.75rem", color: "var(--error-color)" }}>Rejected Candidates</div>
          <div className="cardValue" style={{ fontSize: "1.6rem", color: "var(--error-color)" }}>{stats.rejectedCount}</div>
        </div>
      </div>

      {/* 3. SPLIT WORKSPACE */}
      <div className="layoutSplit">
        {/* Left Drawer: Manual Generation Controls */}
        <TopicGenerationForm
          onTriggerSuccess={refreshData}
          isLlmStub={isLlmStub}
          hasNoEvidence={hasNoEvidence}
        />

        {/* Right Panel: Ranked Topic Candidates List */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
            <h3 style={{ color: "var(--text-primary)", fontSize: "1rem", fontWeight: 700 }}>Ranked Debate Topic Candidates</h3>
            <button onClick={refreshData} className="editButton" style={{ fontSize: "0.8rem", padding: "0.25rem 0.75rem" }}>
              Refresh List
            </button>
          </div>
          {topics.length === 0 ? (
            <div className="emptyState">
              <div className="emptyStateTitle">No topic candidates exist yet.</div>
              <div className="emptyStateDesc">
                Run sports data ingestion first, then generate topics from real stored data.
              </div>
            </div>
          ) : (
            <div className="grid">
              {topics.map((topic) => {
                const evidenceList = getArray(topic.evidenceIds);
                const isPending = topic.status === "pending";
                const isApproved = topic.status === "approved";
                const isRejected = topic.status === "rejected";

                return (
                  <div className="topicCard" key={topic.id}>
                    {/* Header */}
                    <div className="topicCardHeader">
                      <div className="topicTitleBlock">
                        <h4 className="topicTitle">{topic.title}</h4>
                        <div className="topicMeta">
                          <span className="metaBadge">{topic.sport}</span>
                          <span className="metaBadge">{topic.leagueId || "GLOBAL"}</span>
                          <span style={{ color: "var(--text-secondary)" }}>
                            Created {new Date(topic.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                      </div>
                      
                      {/* Overall Debate Score Pill */}
                      <div className="scorePill">
                        <span>{Math.round(topic.debateScore)}</span>
                        <span className="scoreLabel">Debate</span>
                      </div>
                    </div>

                    {/* Body */}
                    <div className="topicBody">
                      <p className="topicSummary">{topic.summary}</p>

                      {/* Score break downs */}
                      <div className="scoresGrid">
                        <div className="scoreItem">
                          <span className="scoreItemLabel">Controversy</span>
                          <span className="scoreItemValue" style={{ color: "var(--warning-color)" }}>{topic.controversyScore}</span>
                        </div>
                        <div className="scoreItem">
                          <span className="scoreItemLabel">Star Power</span>
                          <span className="scoreItemValue" style={{ color: "#7c3aed" }}>{topic.starPowerScore}</span>
                        </div>
                        <div className="scoreItem">
                          <span className="scoreItemLabel">Betting Relevance</span>
                          <span className="scoreItemValue" style={{ color: "var(--accent-color)" }}>{topic.bettingRelevanceScore}</span>
                        </div>
                        <div className="scoreItem">
                          <span className="scoreItemLabel">Recency</span>
                          <span className="scoreItemValue" style={{ color: "var(--text-secondary)" }}>{topic.recencyScore}</span>
                        </div>
                      </div>

                      {/* Evidence linking lists */}
                      <div className="evidenceList">
                        <span className="sectionLabel" style={{ fontSize: "0.7rem", marginBottom: "0.25rem", fontWeight: 600, textTransform: "uppercase", color: "var(--text-secondary)", letterSpacing: "0.02em" }}>Supporting Evidence Records</span>
                        {evidenceList.length === 0 ? (
                          <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)", fontStyle: "italic" }}>No evidence links found.</span>
                        ) : (
                          evidenceList.map((ref: any, idx: number) => (
                            <div className="evidenceItem" key={idx}>
                              <span className={`evidenceBadge badge${ref.type.charAt(0).toUpperCase() + ref.type.slice(1)}`}>
                                {ref.type}
                              </span>
                              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.75rem", color: "var(--text-primary)" }}>
                                {ref.id}
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    {/* Footer */}
                    <div className="topicCardFooter">
                      <div>
                        <span
                          className={`badge ${
                            isApproved
                              ? "badgeCompleted"
                              : isRejected
                              ? "badgeFailed"
                              : "badgePending"
                          }`}
                        >
                          {topic.status}
                        </span>
                      </div>
                      
                      <div className="actionsGroup">
                        {isPending && (
                          <>
                            <button
                              onClick={() => handleReject(topic.id)}
                              disabled={loadingId === topic.id}
                              className="btnReject"
                            >
                              Reject
                            </button>
                            <button
                              onClick={() => handleApprove(topic.id)}
                              disabled={loadingId === topic.id}
                              className="btnApprove"
                            >
                              Approve
                            </button>
                          </>
                        )}
                        {!isPending && (
                          <button
                            onClick={() => handleReset(topic.id)}
                            disabled={loadingId === topic.id}
                            className="btnReset"
                          >
                            Reset status
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
