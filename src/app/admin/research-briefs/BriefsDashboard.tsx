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

  // New Editorial Fields
  classification?: string | null;
  mainAngle?: string | null;
  whyMattersNow?: string | null;
  keyFactsContext?: any;
  onAirTalkingPoints?: any;
  contrarianAngle?: string | null;
  strongestDebateQuestion?: string | null;
  suggestedHostTake?: string | null;
  sourceNotesUsed?: string | null;
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
  const [showSpokenPrep, setShowSpokenPrep] = useState(false);

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
                  <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
                    <h4 className="detailPanelTitle" style={{ margin: 0 }}>{selectedTopic.title}</h4>
                    {selectedTopic.brief.classification && (
                      <span className={`classificationBadge badge-${selectedTopic.brief.classification}`}>
                        {selectedTopic.brief.classification.replace("_", " ")}
                      </span>
                    )}
                  </div>
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
                
                {/* Source Transparency & Audit Trail */}
                <div>
                  <h5 className="detailSectionTitle">Sources Used Transparency</h5>
                  <div className="sourcesUsedCard">
                    <div className="sourcesUsedHeader">
                      <span style={{ fontSize: "1.1rem" }}>🔍</span> Audit Trail log
                    </div>
                    {selectedTopic.brief.sourceNotesUsed ? (
                      <ul className="sourcesUsedList">
                        {selectedTopic.brief.sourceNotesUsed.split("\n").map((line, idx) => {
                          const cleanLine = line.replace(/^[-\s*•]+/, "").trim();
                          if (!cleanLine) return null;
                          let dotClass = "sourceDotActive";
                          if (cleanLine.includes("skipped")) {
                            dotClass = "sourceDotSkipped";
                          } else if (cleanLine.includes("unavailable") || cleanLine.includes("error") || cleanLine.includes("missing")) {
                            dotClass = "sourceDotUnavailable";
                          }
                          return (
                            <li key={idx} className="sourcesUsedListItem">
                              <span className={`sourceDot ${dotClass}`} />
                              <span>{cleanLine}</span>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", margin: 0, fontStyle: "italic" }}>
                        No audit trail logged for this brief.
                      </p>
                    )}
                  </div>
                </div>

                {/* Editorial Angles */}
                {selectedTopic.brief.mainAngle && (
                  <div className="editorialCallout">
                    <div className="editorialCalloutTitle">Editorial Angle</div>
                    <div className="editorialCalloutText">{selectedTopic.brief.mainAngle}</div>
                  </div>
                )}

                {selectedTopic.brief.whyMattersNow && (
                  <div>
                    <h5 className="detailSectionTitle">Why This Matters Now</h5>
                    <p className="contextText" style={{ fontStyle: "italic" }}>{selectedTopic.brief.whyMattersNow}</p>
                  </div>
                )}

                {/* 1. Facts Section */}
                <div>
                  <h5 className="detailSectionTitle">Key Facts & Context</h5>
                  <ul className="bulletList">
                    {getArray(selectedTopic.brief.keyFactsContext || selectedTopic.brief.facts).map((fact: FactItem, idx) => (
                      <li key={idx} className="bulletItem">
                        <div>
                          <span>• {fact.text}</span>
                          {fact.confidence && (
                            <span className={`confidenceBadge confidence${fact.confidence.charAt(0).toUpperCase() + fact.confidence.slice(1)}`}>
                              {fact.confidence}
                            </span>
                          )}
                        </div>
                        {getArray(fact.evidenceRefs).length > 0 && (
                          <div className="bulletRefs">
                            {getArray(fact.evidenceRefs).map((ref, rIdx) => (
                              <span key={rIdx} className="refBadge">
                                {ref.type}: {ref.id}
                              </span>
                            ))}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>

                {/* 2. Stats Section / Best On-Air Talking Points */}
                <div>
                  <h5 className="detailSectionTitle">Best On-Air Talking Points</h5>
                  <ul className="bulletList">
                    {getArray(selectedTopic.brief.onAirTalkingPoints || selectedTopic.brief.stats).map((stat: StatItem, idx) => (
                      <li key={idx} className="bulletItem">
                        <div>• {stat.text}</div>
                        {getArray(stat.evidenceRefs).length > 0 && (
                          <div className="bulletRefs">
                            {getArray(stat.evidenceRefs).map((ref, rIdx) => (
                              <span key={rIdx} className="refBadge">
                                {ref.type}: {ref.id}
                              </span>
                            ))}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Injury Context */}
                {selectedTopic.brief.injuryContext && (
                  <div>
                    <h5 className="detailSectionTitle">Injury Report Context</h5>
                    <p className="contextText">{selectedTopic.brief.injuryContext}</p>
                  </div>
                )}

                {/* Odds Context */}
                {selectedTopic.brief.oddsContext && (
                  <div>
                    <h5 className="detailSectionTitle">Odds & Betting Context</h5>
                    <p className="contextText">{selectedTopic.brief.oddsContext}</p>
                  </div>
                )}

                {/* Debate Stance Highlights */}
                {selectedTopic.brief.strongestDebateQuestion && (
                  <div className="debateQuestionCallout">
                    <div style={{ fontSize: "0.7rem", textTransform: "uppercase", fontWeight: 700, letterSpacing: "0.05em", color: "#6366f1", marginBottom: "0.25rem" }}>
                      Strongest Segment Debate Question
                    </div>
                    <div className="debateQuestionText">"{selectedTopic.brief.strongestDebateQuestion}"</div>
                  </div>
                )}

                {selectedTopic.brief.contrarianAngle && (
                  <div>
                    <h5 className="detailSectionTitle">Contrarian View</h5>
                    <p className="contextText" style={{ borderLeft: "3px solid #ec4899", paddingLeft: "1rem" }}>
                      {selectedTopic.brief.contrarianAngle}
                    </p>
                  </div>
                )}

                {selectedTopic.brief.suggestedHostTake && (
                  <div>
                    <h5 className="detailSectionTitle">Suggested Host Take</h5>
                    <p className="contextText" style={{ borderLeft: "3px solid #10b981", paddingLeft: "1rem" }}>
                      {selectedTopic.brief.suggestedHostTake}
                    </p>
                  </div>
                )}

                {/* Collapsible Spoken Prep Section */}
                <div style={{ marginTop: "1rem", borderTop: "1px dashed var(--border-color)", paddingTop: "1.5rem" }}>
                  <button
                    onClick={() => setShowSpokenPrep(!showSpokenPrep)}
                    className="btnApprove"
                    style={{
                      fontSize: "0.8rem",
                      padding: "0.4rem 1rem",
                      background: "transparent",
                      border: "1px solid var(--border-color)",
                      color: "var(--text-primary)",
                    }}
                  >
                    {showSpokenPrep ? "Hide Host Stances & Dialogue" : "Show Spoken Host Stances & Dialogue"}
                  </button>

                  {showSpokenPrep && (
                    <div style={{ marginTop: "1.5rem", display: "flex", flexDirection: "column", gap: "1.5rem" }}>
                      {/* Host Debate Arguments */}
                      <div>
                        <h5 className="detailSectionTitle">Debate Stance Arguments</h5>
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

                      {/* Dialogue CounterArguments */}
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
                                {getArray(item.evidenceRefs).length > 0 && (
                                  <div className="bulletRefs" style={{ marginTop: "0.35rem" }}>
                                    {getArray(item.evidenceRefs).map((ref, rIdx) => (
                                      <span key={rIdx} className="refBadge" style={{ fontSize: "0.6rem" }}>
                                        {ref.type}: {ref.id}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Unsafe Claims Section */}
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
                    </div>
                  )}
                </div>

                {/* Evidence Source IDs */}
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
