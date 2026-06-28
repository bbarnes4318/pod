import React from "react";
import { fetchFactCheckDetail } from "../actions";
import Link from "next/link";
import "../../scripts/scripts.css";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function FactCheckDetailPage({ params }: PageProps) {
  const { id } = await params;
  const res = await fetchFactCheckDetail(id);

  if (!res.success || !res.factCheck) {
    notFound();
  }

  const fc = res.factCheck;
  const summary = fc.summary || {};
  const issues = fc.issues || {};
  const coverage = fc.evidenceCoverage || {};

  const errors = Array.isArray(issues.errors) ? issues.errors : [];
  const warnings = Array.isArray(issues.warnings) ? issues.warnings : [];
  const semanticLineResults = Array.isArray(issues.semanticLineResults) ? issues.semanticLineResults : [];

  const isPassed = fc.status === "passed";
  const isFailed = fc.status === "failed";
  const isReview = fc.status === "needs_review";

  const totalLineCount = coverage.totalLineCount || 0;
  const factualLineCount = coverage.factualLineCount || 0;
  const factualLineWithValidEvidenceCount = coverage.factualLineWithValidEvidenceCount || 0;
  const evidenceCoveragePercent = coverage.evidenceCoveragePercent !== undefined ? coverage.evidenceCoveragePercent : 100;
  
  const invalidEvidenceRefCount = coverage.invalidEvidenceRefCount || 0;
  const unsupportedClaimCount = coverage.unsupportedClaimCount || 0;
  const unsafeClaimCount = coverage.unsafeClaimCount || 0;
  const rumorLanguageCount = coverage.rumorLanguageCount || 0;
  const needsHumanReviewCount = coverage.needsHumanReviewCount || 0;
  const invalidSpeakerCount = coverage.invalidSpeakerCount || 0;
  const hostLineShare = coverage.hostLineShare || { "Max Voltage": 0, "Dr. Linebreak": 0 };

  return (
    <div className="formContainer" style={{ maxWidth: "100%" }}>
      {/* Navigation Top Bar */}
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "1.5rem" }}>
        <div style={{ display: "flex", gap: "1rem" }}>
          <Link href="/admin/fact-checks" className="btnReset" style={{ fontSize: "0.85rem", textDecoration: "none" }}>
            ← Back to Fact Checks Dashboard
          </Link>
          <Link href={`/admin/episodes/${fc.episodeId}`} className="btnReset" style={{ fontSize: "0.85rem", textDecoration: "none" }}>
            Goto Episode Details
          </Link>
          <Link href={`/admin/scripts/${fc.scriptId}`} className="btnReset" style={{ fontSize: "0.85rem", textDecoration: "none" }}>
            Goto Script Console
          </Link>
        </div>
        <div style={{ color: "#94a3b8", fontSize: "0.85rem" }}>
          Checked At: <strong style={{ color: "#ffffff" }}>{new Date(fc.checkedAt).toLocaleString()}</strong>
        </div>
      </div>

      {/* Main Header Card */}
      <div className="scriptsHeader">
        <div>
          <h2 style={{ fontSize: "1.5rem", color: "#ffffff", margin: 0 }}>
            Fact Check Report: Version {fc.version}
          </h2>
          <span style={{ fontSize: "0.85rem", color: "#64748b" }}>
            Episode: <strong style={{ color: "#ffffff" }}>{fc.episodeTitle}</strong>
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "1.25rem" }}>
          <div style={{ textAlign: "right" }}>
            <span style={{ fontSize: "0.75rem", color: "#64748b", display: "block" }}>Safety Provider</span>
            <span style={{ fontSize: "0.85rem", color: "#38bdf8", fontWeight: 700, fontFamily: "var(--font-mono)" }}>
              {fc.provider}
            </span>
          </div>
          <span className={`badge ${
            isPassed
              ? "badgeCompleted"
              : isFailed
              ? "badgeFailed"
              : "badgePending"
          }`} style={{ fontSize: "1rem", padding: "0.5rem 1.25rem" }}>
            {fc.status}
          </span>
        </div>
      </div>

      {/* Split grid layout */}
      <div className="scriptReviewLayout" style={{ marginTop: "1.5rem" }}>
        
        {/* Left column: Issue Logs & Line Audits */}
        <div>
          
          {/* Summary / Audit Header */}
          <div className="editorPanel" style={{ marginBottom: "1.5rem" }}>
            <div className="panelTitle">Semantic Summary</div>
            <p style={{ margin: 0, fontSize: "0.9rem", color: "#cbd5e1", lineHeight: 1.6 }}>
              {summary.semanticSummary || "No semantic summary generated."}
            </p>
          </div>

          {/* Hard safety validation errors (fails) */}
          <div className="editorPanel" style={{ marginBottom: "1.5rem" }}>
            <div className="panelTitle" style={{ color: "#ef4444" }}>
              Deterministic Validation Errors ({errors.length})
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {errors.map((err: any, idx: number) => (
                <div key={idx} style={{ padding: "0.75rem", backgroundColor: "rgba(239, 68, 68, 0.05)", borderLeft: "4px solid #ef4444", borderRadius: "4px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "#94a3b8", marginBottom: "0.25rem" }}>
                    <span>Type: {err.type || "general"}</span>
                    {err.lineIndex !== undefined && <span>Line: #{err.lineIndex + 1}</span>}
                  </div>
                  <p style={{ margin: 0, fontSize: "0.85rem", color: "#cbd5e1" }}>{err.reason}</p>
                </div>
              ))}

              {errors.length === 0 && (
                <p style={{ margin: 0, color: "#64748b", fontStyle: "italic", fontSize: "0.85rem" }}>
                  No deterministic errors found. All structure, speakers, and evidence constraints passed.
                </p>
              )}
            </div>
          </div>

          {/* Warnings List */}
          <div className="editorPanel" style={{ marginBottom: "1.5rem" }}>
            <div className="panelTitle" style={{ color: "#f59e0b" }}>
              Deterministic Validation Warnings ({warnings.length})
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {warnings.map((warn: any, idx: number) => (
                <div key={idx} style={{ padding: "0.75rem", backgroundColor: "rgba(245, 158, 11, 0.05)", borderLeft: "4px solid #f59e0b", borderRadius: "4px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "#94a3b8", marginBottom: "0.25rem" }}>
                    <span>Type: {warn.type || "warning"}</span>
                    {warn.lineIndex !== undefined && <span>Line: #{warn.lineIndex + 1}</span>}
                  </div>
                  <p style={{ margin: 0, fontSize: "0.85rem", color: "#cbd5e1" }}>{warn.reason}</p>
                </div>
              ))}

              {warnings.length === 0 && (
                <p style={{ margin: 0, color: "#64748b", fontStyle: "italic", fontSize: "0.85rem" }}>
                  No deterministic warnings found.
                </p>
              )}
            </div>
          </div>

          {/* LLM semantic audit details */}
          {semanticLineResults.length > 0 && (
            <div className="editorPanel">
              <div className="panelTitle">Semantic Line Audits ({semanticLineResults.length})</div>
              
              <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                {semanticLineResults.map((lr: any, idx: number) => {
                  const lrStatus = lr.status; // "supported" | "unsupported" | "needs_review"
                  const badgeColor = lrStatus === "supported" ? "#10b981" : lrStatus === "unsupported" ? "#ef4444" : "#f59e0b";

                  return (
                    <div key={idx} style={{ backgroundColor: "#080b10", border: "1px solid #161f30", borderRadius: "4px", padding: "1rem" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                        <span style={{ fontSize: "0.8rem", fontWeight: 700, color: "#38bdf8" }}>
                          Line #{lr.lineIndex + 1} ({lr.speakerName})
                        </span>
                        <span style={{ fontSize: "0.7rem", fontWeight: 700, color: badgeColor, textTransform: "uppercase", padding: "0.15rem 0.4rem", backgroundColor: "rgba(0,0,0,0.3)", borderRadius: "3px" }}>
                          {lrStatus}
                        </span>
                      </div>

                      <p style={{ margin: "0 0 0.5rem", fontSize: "0.85rem", color: "#cbd5e1", fontStyle: "italic" }}>
                        "{lr.claimText}"
                      </p>

                      <div style={{ fontSize: "0.8rem", color: "#94a3b8" }}>
                        <strong>Reasoning:</strong> {lr.reason}
                      </div>

                      {lr.suggestedFix && (
                        <div style={{ fontSize: "0.8rem", color: "#f59e0b", marginTop: "0.35rem" }}>
                          <strong>Suggested Fix:</strong> {lr.suggestedFix}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

        </div>

        {/* Right column: Safety metrics and splits */}
        <div className="sideControls">
          
          {/* Safety metrics panel */}
          <div className="controlsPanel">
            <div className="panelTitle">Audit Metrics</div>
            
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", fontSize: "0.85rem", color: "#cbd5e1" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Factual Line Count:</span>
                <strong style={{ color: "#ffffff" }}>{factualLineCount} / {totalLineCount}</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Valid Evidence Coverage:</span>
                <strong style={{ color: evidenceCoveragePercent === 100 ? "#10b981" : "#ef4444" }}>
                  {evidenceCoveragePercent}%
                </strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Invalid Evidence Refs:</span>
                <strong style={{ color: invalidEvidenceRefCount > 0 ? "#ef4444" : "#ffffff" }}>
                  {invalidEvidenceRefCount}
                </strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Unsupported Claims:</span>
                <strong style={{ color: unsupportedClaimCount > 0 ? "#ef4444" : "#ffffff" }}>
                  {unsupportedClaimCount}
                </strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Unsafe Claims:</span>
                <strong style={{ color: unsafeClaimCount > 0 ? "#f43f5e" : "#ffffff" }}>
                  {unsafeClaimCount}
                </strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Rumor Language:</span>
                <strong style={{ color: rumorLanguageCount > 0 ? "#ef4444" : "#ffffff" }}>
                  {rumorLanguageCount}
                </strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Flagged for Review:</span>
                <strong style={{ color: needsHumanReviewCount > 0 ? "#f59e0b" : "#ffffff" }}>
                  {needsHumanReviewCount}
                </strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Invalid Speakers:</span>
                <strong style={{ color: invalidSpeakerCount > 0 ? "#ef4444" : "#ffffff" }}>
                  {invalidSpeakerCount}
                </strong>
              </div>

              {/* Host shares */}
              <div style={{ borderTop: "1px solid #161f30", paddingTop: "0.5rem", marginTop: "0.5rem" }}>
                <span className="sectionGroupLabel" style={{ fontSize: "0.7rem" }}>Dialogue Splits</span>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", marginTop: "0.25rem" }}>
                  <span>Max Voltage:</span>
                  <strong style={{ color: hostLineShare["Max Voltage"] >= 25 ? "#10b981" : "#ef4444" }}>
                    {hostLineShare["Max Voltage"]}%
                  </strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem" }}>
                  <span>Dr. Linebreak:</span>
                  <strong style={{ color: hostLineShare["Dr. Linebreak"] >= 25 ? "#10b981" : "#ef4444" }}>
                    {hostLineShare["Dr. Linebreak"]}%
                  </strong>
                </div>
              </div>

            </div>
          </div>

          {/* Prompt 10 details block */}
          <div className="controlsPanel">
            <div className="panelTitle">safety guidelines</div>
            <p style={{ margin: 0, fontSize: "0.75rem", color: "#64748b", lineHeight: 1.5 }}>
              Dialogue script fact-checking ensures hosts argue strictly using ground-truth facts. Factual claims must trace to database records, and prohibited rumor phrases or unverified unsafe claims are safety-flagged to prevent hallucinations.
            </p>
          </div>

        </div>

      </div>
    </div>
  );
}
