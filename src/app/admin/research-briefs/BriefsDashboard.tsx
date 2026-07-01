"use client";

import React, { useState } from "react";
import Link from "next/link";
import { triggerResearchBriefGeneration, deleteResearchBrief } from "./actions";

interface EvidenceRef {
  type: string;
  id: string;
}

interface FactItem {
  text: string;
  confidence: "high" | "medium" | "low";
  evidenceRefs: EvidenceRef[];
}

interface StatItem {
  text: string;
  evidenceRefs: EvidenceRef[];
  confidence?: string;
}

interface DialogueItem {
  host: string;
  claim: string;
  evidenceRefs: EvidenceRef[];
}

interface UnsafeClaimItem {
  claim: string;
  reason: string;
}

interface ResearchBrief {
  id: string;
  topicId: string;
  facts: any; // FactItem[]
  stats: any; // StatItem[]
  injuryContext: string | null;
  oddsContext: string | null;
  argumentForHostA: string;
  argumentForHostB: string;
  counterArguments: any; // DialogueItem[]
  unsafeClaims: any; // UnsafeClaimItem[]
  sourceIds: any; // EvidenceRef[]
}

interface TopicWithBrief {
  id: string;
  title: string;
  sport: string;
  leagueId: string | null;
  summary: string | null;
  debateScore: number;
  evidenceIds: any; // EvidenceRef[]
  brief: ResearchBrief | null;
}

interface DashboardProps {
  topics: TopicWithBrief[];
  isLlmStub: boolean;
}

export default function BriefsDashboard({ topics, isLlmStub }: DashboardProps) {
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(
    topics.length > 0 ? topics[0].id : null
  );
  const [loadingTopicId, setLoadingTopicId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const selectedTopic = topics.find((t) => t.id === selectedTopicId);

  const handleGenerate = async (topicId: string, force = false) => {
    setLoadingTopicId(topicId);
    setStatusMessage(null);

    const res = await triggerResearchBriefGeneration(topicId, force);
    if (res.success) {
      setStatusMessage({
        type: "success",
        text: `Generation job queued successfully! Job ID: ${res.jobId}. Monitor your worker window to watch processing progress.`,
      });
      // Automatically refresh the page shortly
      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } else {
      setStatusMessage({
        type: "error",
        text: res.error || "Failed to trigger brief generation.",
      });
    }
    setLoadingTopicId(null);
  };

  const handleDelete = async (briefId: string) => {
    if (!confirm("Are you sure you want to delete this research brief? (Admin cleanup utility)")) return;
    const res = await deleteResearchBrief(briefId);
    if (res.success) {
      window.location.reload();
    } else {
      alert(res.error || "Failed to delete brief.");
    }
  };

  const getArray = (val: any): any[] => {
    if (Array.isArray(val)) return val;
    return [];
  };

  return (
    <div>
      {/* Stub Warning */}
      {isLlmStub && (
        <div className="alertCard alertDanger">
          <strong>⚠️ LLM provider is stub. Real research brief generation disabled.</strong>
          <p style={{ marginTop: "0.25rem", opacity: 0.9 }}>
            Configure a real LLM provider (OpenAI or Anthropic) in your environment variables to enable structured debate brief generation.
          </p>
        </div>
      )}

      {statusMessage && (
        <div
          className={`alertCard ${statusMessage.type === "success" ? "alertSuccess" : "alertDanger"}`}
          style={{ marginBottom: "1.5rem" }}
        >
          {statusMessage.text}
        </div>
      )}

      <div className="briefsLayout">
        {/* Left Side: Approved Topics List */}
        <div className="panel" style={{ padding: 0 }}>
          <div className="panelHeader">
            <h3 className="panelTitle">Approved Topics ({topics.length})</h3>
          </div>
          
          {topics.length === 0 ? (
            <div className="emptyState" style={{ border: "none", borderRadius: 0 }}>
              <div className="emptyStateTitle">No approved topics found.</div>
              <div className="emptyStateDesc">
                Approve topic candidates before generating research briefs. Go to the <Link href="/admin/topics" style={{ color: "var(--accent-color)", textDecoration: "underline", fontWeight: 600 }}>Topic Engine</Link> to approve topics first.
              </div>
            </div>
          ) : (
            <div className="topicListCard" style={{ border: "none", borderRadius: 0 }}>
              {topics.map((t) => {
                const isActive = t.id === selectedTopicId;
                const hasBrief = !!t.brief;
                const evidenceCount = getArray(t.evidenceIds).length;

                return (
                  <div
                    key={t.id}
                    className={`topicListItem ${isActive ? "topicListItemActive" : ""}`}
                    onClick={() => {
                      setSelectedTopicId(t.id);
                      setStatusMessage(null);
                    }}
                  >
                    <div className="topicItemHeader">
                      <span className="topicItemTitle">{t.title}</span>
                    </div>

                    <div className="topicItemMeta">
                      <span>{t.sport}</span>
                      <span>•</span>
                      <span>Score: {Math.round(t.debateScore)}</span>
                      <span>•</span>
                      <span>Evidence: {evidenceCount}</span>
                    </div>

                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "0.25rem" }}>
                      <span className={`statusIndicator ${hasBrief ? "statusGreen" : "statusOrange"}`}>
                        <span className="statusIndicatorDot" />
                        {hasBrief ? "Brief Ready" : "No Brief"}
                      </span>

                      <div className="topicItemActions" onClick={(e) => e.stopPropagation()}>
                        {!hasBrief ? (
                          <button
                            onClick={() => handleGenerate(t.id, false)}
                            disabled={loadingTopicId !== null || isLlmStub}
                            className="btnApprove"
                            style={{ fontSize: "0.75rem", padding: "0.2rem 0.6rem" }}
                          >
                            {loadingTopicId === t.id ? "Generating..." : "Generate"}
                          </button>
                        ) : (
                          <button
                            onClick={() => handleGenerate(t.id, true)}
                            disabled={loadingTopicId !== null || isLlmStub}
                            className="btnReset"
                            style={{ fontSize: "0.75rem", padding: "0.2rem 0.6rem" }}
                          >
                            {loadingTopicId === t.id ? "Regenerating..." : "Regen"}
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

        {/* Right Side: Detailed View Panel */}
        <div className="detailPanel">
          {!selectedTopic ? (
            <div className="emptyState" style={{ border: "none", flexGrow: 1, height: "100%" }}>
              <div className="emptyStateDesc">Select a topic on the left to view brief details.</div>
            </div>
          ) : !selectedTopic.brief ? (
            <div className="emptyState" style={{ border: "none", flexGrow: 1, height: "100%", gap: "1rem" }}>
              <div className="emptyStateTitle">No Research Brief has been generated for this topic yet.</div>
              <button
                onClick={() => handleGenerate(selectedTopic.id, false)}
                disabled={loadingTopicId !== null || isLlmStub}
                className="btnApprove"
                style={{ padding: "0.5rem 1.5rem" }}
              >
                {loadingTopicId === selectedTopic.id ? "Queuing Generator..." : "Generate Research Brief"}
              </button>
            </div>
          ) : (
            <>
              {/* Panel Header */}
              <div className="detailPanelHeader">
                <div>
                  <h4 className="detailPanelTitle">{selectedTopic.title}</h4>
                  <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginTop: "0.25rem" }}>
                    Sport: {selectedTopic.sport} | League: {selectedTopic.leagueId || "GLOBAL"}
                  </p>
                </div>
                
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button
                    onClick={() => handleGenerate(selectedTopic.id, true)}
                    disabled={loadingTopicId !== null || isLlmStub}
                    className="btnReset"
                    style={{ fontSize: "0.8rem", padding: "0.4rem 0.8rem" }}
                  >
                    Force Regen
                  </button>
                  <button
                    onClick={() => handleDelete(selectedTopic.brief!.id)}
                    className="btnReject"
                    style={{ fontSize: "0.8rem", padding: "0.4rem 0.8rem" }}
                  >
                    Delete Brief
                  </button>
                </div>
              </div>

              {/* Panel Content */}
              <div className="detailPanelContent">
                {/* 1. Facts Section */}
                <div>
                  <h5 className="detailSectionTitle">Facts & Bulletpoints</h5>
                  <ul className="bulletList">
                    {getArray(selectedTopic.brief.facts).map((fact: FactItem, idx) => (
                      <li key={idx} className="bulletItem">
                        <div>
                          <span>• {fact.text}</span>
                          <span className={`confidenceBadge confidence${fact.confidence.charAt(0).toUpperCase() + fact.confidence.slice(1)}`}>
                            {fact.confidence}
                          </span>
                        </div>
                        <div className="bulletRefs">
                          {getArray(fact.evidenceRefs).map((ref, rIdx) => (
                            <span key={rIdx} className="refBadge">
                              {ref.type}: {ref.id}
                            </span>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* 2. Stats Section */}
                <div>
                  <h5 className="detailSectionTitle">Statistical Notes</h5>
                  <ul className="bulletList">
                    {getArray(selectedTopic.brief.stats).map((stat: StatItem, idx) => (
                      <li key={idx} className="bulletItem">
                        <div>• {stat.text}</div>
                        <div className="bulletRefs">
                          {getArray(stat.evidenceRefs).map((ref, rIdx) => (
                            <span key={rIdx} className="refBadge">
                              {ref.type}: {ref.id}
                            </span>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* 3. Injury Context */}
                {selectedTopic.brief.injuryContext && (
                  <div>
                    <h5 className="detailSectionTitle">Injury Report Context</h5>
                    <p className="contextText">{selectedTopic.brief.injuryContext}</p>
                  </div>
                )}

                {/* 4. Odds Context */}
                {selectedTopic.brief.oddsContext && (
                  <div>
                    <h5 className="detailSectionTitle">Odds & Betting Context</h5>
                    <p className="contextText">{selectedTopic.brief.oddsContext}</p>
                  </div>
                )}

                {/* 5. Host Debate Arguments */}
                <div>
                  <h5 className="detailSectionTitle">Debate Arguments</h5>
                  <div className="debateGrid">
                    <div className="hostBox" style={{ borderLeft: "3px solid var(--error-color)" }}>
                      <div className="hostHeader">
                        <span className="hostAvatar" style={{ backgroundColor: "var(--error-color)" }} />
                        <span className="hostName" style={{ color: "var(--error-color)" }}>Max Voltage Stance</span>
                      </div>
                      <p className="hostStance">{selectedTopic.brief.argumentForHostA}</p>
                    </div>

                    <div className="hostBox" style={{ borderLeft: "3px solid var(--accent-color)" }}>
                      <div className="hostHeader">
                        <span className="hostAvatar" style={{ backgroundColor: "var(--accent-color)" }} />
                        <span className="hostName" style={{ color: "var(--accent-color)" }}>Dr. Linebreak Stance</span>
                      </div>
                      <p className="hostStance">{selectedTopic.brief.argumentForHostB}</p>
                    </div>
                  </div>
                </div>

                {/* 6. Dialogue CounterArguments */}
                <div>
                  <h5 className="detailSectionTitle">Dialogue Back-And-Forth</h5>
                  <div className="backAndForth">
                    {getArray(selectedTopic.brief.counterArguments).map((item: DialogueItem, idx) => (
                      <div key={idx} className="dialogueRow">
                        <span
                          className="dialogueSpeaker"
                          style={{ color: item.host === "Dr. Linebreak" ? "var(--accent-color)" : "var(--error-color)" }}
                        >
                          {item.host}:
                        </span>
                        <div style={{ flexGrow: 1 }}>
                          <span className="dialogueText">{item.claim}</span>
                          <div className="bulletRefs" style={{ marginTop: "0.35rem" }}>
                            {getArray(item.evidenceRefs).map((ref, rIdx) => (
                              <span key={rIdx} className="refBadge" style={{ fontSize: "0.6rem" }}>
                                {ref.type}: {ref.id}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 7. Unsafe Claims Section */}
                <div>
                  <h5 className="detailSectionTitle">Unsafe / Unverified Claims</h5>
                  {getArray(selectedTopic.brief.unsafeClaims).length === 0 ? (
                    <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", fontStyle: "italic" }}>
                      No unsafe claims detected. Brief is fully grounded.
                    </p>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                      {getArray(selectedTopic.brief.unsafeClaims).map((claim: UnsafeClaimItem, idx) => (
                        <div key={idx} className="unsafeClaimItem">
                          <span className="unsafeClaimText">"{claim.claim}"</span>
                          <span className="unsafeClaimReason">Reason: {claim.reason}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* 8. Source IDs */}
                <div>
                  <h5 className="detailSectionTitle">Brief Source Evidences</h5>
                  <div className="bulletRefs">
                    {getArray(selectedTopic.brief.sourceIds).map((ref: EvidenceRef, idx) => (
                      <span key={idx} className="refBadge" style={{ fontSize: "0.75rem", padding: "0.25rem 0.5rem" }}>
                        {ref.type}: {ref.id}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
