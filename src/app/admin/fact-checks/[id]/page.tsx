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

  const totalLineCount = coverage.totalLineCount || 0;
  const factualLineCount = coverage.factualLineCount || 0;
  const evidenceCoveragePercent = coverage.evidenceCoveragePercent !== undefined ? coverage.evidenceCoveragePercent : 100;
  
  const invalidEvidenceRefCount = coverage.invalidEvidenceRefCount || 0;
  const unsupportedClaimCount = coverage.unsupportedClaimCount || 0;
  const unsafeClaimCount = coverage.unsafeClaimCount || 0;
  const rumorLanguageCount = coverage.rumorLanguageCount || 0;
  const needsHumanReviewCount = coverage.needsHumanReviewCount || 0;
  const invalidSpeakerCount = coverage.invalidSpeakerCount || 0;
  const hostLineShare: Record<string, number> = coverage.hostLineShare || {};

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
        <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>
          Checked At: <strong style={{ color: "var(--text-primary)" }}>{new Date(fc.checkedAt).toLocaleString()}</strong>
        </div>
      </div>

      {/* Main Header Card */}
      <div className="scriptsHeader">
        <div>
          <h2 className="pageTitle">
            Fact Check Report: Version {fc.version}
          </h2>
          <span style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
            Episode: <strong style={{ color: "var(--text-primary)" }}>{fc.episodeTitle}</strong>
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "1.25rem" }}>
          <div style={{ textAlign: "right" }}>
            <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)", display: "block" }}>Safety Provider</span>
            <span style={{ fontSize: "0.85rem", color: "var(--accent-color)", fontWeight: 700, fontFamily: "var(--font-mono)" }}>
              {fc.provider}
            </span>
          </div>
          <span className={`badge ${
            isPassed
              ? "badgeCompleted"
              : isFailed
              ? "badgeFailed"
              : "badgePending"
          }`} style={{ fontSize: "0.95rem", padding: "0.5rem 1.25rem" }}>
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
            <p style={{ margin: 0, fontSize: "0.9rem", color: "var(--text-primary)", lineHeight: 1.5 }}>
              {typeof summary.semanticSummary === "object" && summary.semanticSummary !== null
                ? (summary.semanticSummary.overallAssessment || "No overall assessment summary.")
                : (summary.semanticSummary || "No semantic summary generated.")}
            </p>
          </div>

          {/* Hard safety validation errors (fails) */}
          <div className="editorPanel" style={{ marginBottom: "1.5rem" }}>
            <div className="panelTitle" style={{ color: "var(--error-color)" }}>
              Deterministic Validation Errors ({errors.length})
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {errors.map((err: any, idx: number) => (
                <div key={idx} style={{ padding: "0.75rem", backgroundColor: "var(--error-muted)", border: "1px solid var(--error-border)", borderLeft: "4px solid var(--error-color)", borderRadius: "6px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "var(--text-secondary)", marginBottom: "0.25rem" }}>
                    <span>Type: {err.type || "general"}</span>
                    {err.lineIndex !== undefined && <span>Line: #{err.lineIndex + 1}</span>}
                  </div>
                  <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--text-primary)" }}>{err.reason}</p>
                </div>
              ))}

              {errors.length === 0 && (
                <p style={{ margin: 0, color: "var(--text-secondary)", fontStyle: "italic", fontSize: "0.85rem" }}>
                  No deterministic errors found. All structure, speakers, and evidence constraints passed.
                </p>
              )}
            </div>
          </div>

          {/* Warnings List */}
          <div className="editorPanel" style={{ marginBottom: "1.5rem" }}>
            <div className="panelTitle" style={{ color: "var(--warning-color)" }}>
              Deterministic Validation Warnings ({warnings.length})
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {warnings.map((warn: any, idx: number) => (
                <div key={idx} style={{ padding: "0.75rem", backgroundColor: "var(--warning-muted)", border: "1px solid var(--warning-border)", borderLeft: "4px solid var(--warning-color)", borderRadius: "6px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "var(--text-secondary)", marginBottom: "0.25rem" }}>
                    <span>Type: {warn.type || "warning"}</span>
                    {warn.lineIndex !== undefined && <span>Line: #{warn.lineIndex + 1}</span>}
                  </div>
                  <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--text-primary)" }}>{warn.reason}</p>
                </div>
              ))}

              {warnings.length === 0 && (
                <p style={{ margin: 0, color: "var(--text-secondary)", fontStyle: "italic", fontSize: "0.85rem" }}>
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
                  const badgeClass = lrStatus === "supported" ? "badgeCompleted" : lrStatus === "unsupported" ? "badgeFailed" : "badgePending";

                  return (
                    <div key={idx} style={{ backgroundColor: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: "6px", padding: "1rem" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                        <span style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--accent-color)" }}>
                          Line #{lr.lineIndex + 1} ({lr.speakerName})
                        </span>
                        <span className={`badge ${badgeClass}`} style={{ fontSize: "0.7rem", padding: "0.15rem 0.4rem" }}>
                          {lrStatus}
                        </span>
                      </div>

                      <p style={{ margin: "0 0 0.5rem", fontSize: "0.85rem", color: "var(--text-primary)", fontStyle: "italic" }}>
                        "{lr.claimText}"
                      </p>

                      <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                        <strong style={{ color: "var(--text-primary)" }}>Reasoning:</strong> {lr.reason}
                      </div>

                      {lr.suggestedFix && (
                        <div style={{ fontSize: "0.8rem", color: "var(--warning-color)", marginTop: "0.35rem" }}>
                          <strong style={{ color: "var(--warning-color)" }}>Suggested Fix:</strong> {lr.suggestedFix}
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
            
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", fontSize: "0.85rem", color: "var(--text-primary)" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Factual Line Count:</span>
                <strong>{factualLineCount} / {totalLineCount}</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Valid Evidence Coverage:</span>
                <strong style={{ color: evidenceCoveragePercent === 100 ? "var(--success-color)" : "var(--error-color)" }}>
                  {evidenceCoveragePercent}%
                </strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Invalid Evidence Refs:</span>
                <strong style={{ color: invalidEvidenceRefCount > 0 ? "var(--error-color)" : "var(--text-primary)" }}>
                  {invalidEvidenceRefCount}
                </strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Unsupported Claims:</span>
                <strong style={{ color: unsupportedClaimCount > 0 ? "var(--error-color)" : "var(--text-primary)" }}>
                  {unsupportedClaimCount}
                </strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Unsafe Claims:</span>
                <strong style={{ color: unsafeClaimCount > 0 ? "var(--error-color)" : "var(--text-primary)" }}>
                  {unsafeClaimCount}
                </strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Rumor Language:</span>
                <strong style={{ color: rumorLanguageCount > 0 ? "var(--error-color)" : "var(--text-primary)" }}>
                  {rumorLanguageCount}
                </strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Flagged for Review:</span>
                <strong style={{ color: needsHumanReviewCount > 0 ? "var(--warning-color)" : "var(--text-primary)" }}>
                  {needsHumanReviewCount}
                </strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Invalid Speakers:</span>
                <strong style={{ color: invalidSpeakerCount > 0 ? "var(--error-color)" : "var(--text-primary)" }}>
                  {invalidSpeakerCount}
                </strong>
              </div>

              {/* Host shares — keyed by the episode's real host names */}
              <div style={{ borderTop: "1px solid var(--border-color)", paddingTop: "0.5rem", marginTop: "0.5rem" }}>
                <span className="sectionGroupLabel" style={{ fontSize: "0.7rem" }}>Dialogue Splits</span>
                {Object.entries(hostLineShare).map(([hostName, share], i) => (
                  <div key={hostName} style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", marginTop: i === 0 ? "0.25rem" : 0 }}>
                    <span>{hostName}:</span>
                    <strong style={{ color: (share as number) >= 25 ? "var(--success-color)" : "var(--error-color)" }}>
                      {share as number}%
                    </strong>
                  </div>
                ))}
              </div>

            </div>
          </div>

          {/* Guidelines block */}
          <div className="controlsPanel">
            <div className="panelTitle">safety guidelines</div>
            <p style={{ margin: 0, fontSize: "0.75rem", color: "var(--text-secondary)", lineHeight: 1.4 }}>
              Dialogue script fact-checking ensures hosts argue strictly using ground-truth facts. Factual claims must trace to database records, and prohibited rumor phrases or unverified unsafe claims are safety-flagged to prevent hallucinations.
            </p>
          </div>

        </div>

      </div>
    </div>
  );
}
