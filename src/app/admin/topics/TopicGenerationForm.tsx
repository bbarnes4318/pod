"use client";

import React, { useState, useRef } from "react";
import { triggerTopicGeneration, fetchLatestTopicGenerationLog } from "./actions";

interface FormProps {
  onGenerated: () => void;
  isLlmStub: boolean;
  hasNoEvidence: boolean;
}

// The sport the generator must match is DERIVED from the selected league so the
// two can never disagree. (Picking MLB while a free-text sport stayed
// "Basketball" made the worker reject every candidate as a sport mismatch.)
const LEAGUE_TO_SPORT: Record<string, string> = {
  NFL: "Football",
  NBA: "Basketball",
  MLB: "Baseball",
  NCAAF: "Football",
  NCAAB: "Basketball",
  MMA: "Combat Sports",
};

const LEAGUE_OPTIONS = [
  { value: "", label: "All Leagues" },
  { value: "NFL", label: "NFL — National Football League" },
  { value: "NBA", label: "NBA — National Basketball Association" },
  { value: "MLB", label: "MLB — Major League Baseball" },
  { value: "NCAAF", label: "NCAAF — College Football" },
  { value: "NCAAB", label: "NCAAB — College Basketball" },
  { value: "MMA", label: "MMA — Mixed Martial Arts / UFC" },
];

type RunState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "done"; kind: "success" | "warning" | "error"; title: string; detail?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Turn a completed-but-zero-insert JobLog output into a human reason. */
function summarizeZeroInsert(output: Record<string, any>, leagueLabel: string): string {
  if (output.noEvidenceCount) {
    return `No real ${leagueLabel} evidence found in the database. Ingest ${leagueLabel} data (games / odds / injuries / news) first, then generate.`;
  }
  const parts: string[] = [];
  if (output.leagueMismatchCount) parts.push(`${output.leagueMismatchCount} off-target (sport/league mismatch)`);
  if (output.belowScoreCount) parts.push(`${output.belowScoreCount} below the minimum debate score`);
  if (output.skippedWeakEvidenceCount) parts.push(`${output.skippedWeakEvidenceCount} with too-weak evidence`);
  if (output.invalidEvidenceCount) parts.push(`${output.invalidEvidenceCount} citing evidence not in the DB`);
  if (output.duplicateCount) parts.push(`${output.duplicateCount} duplicates of existing topics`);
  if (output.missingSportCount) parts.push(`${output.missingSportCount} missing sport metadata`);
  if (output.invalidLeagueCount) parts.push(`${output.invalidLeagueCount} with an unsupported league`);
  if (parts.length === 0) return "The model returned no candidates that passed validation.";
  return `Every candidate was filtered out: ${parts.join(", ")}.`;
}

export default function TopicGenerationForm({ onGenerated, isLlmStub, hasNoEvidence }: FormProps) {
  const [leagueId, setLeagueId] = useState("");
  const [minScore, setMinScore] = useState(50);
  const [run, setRun] = useState<RunState>({ phase: "idle" });
  const busyRef = useRef(false);

  const sport = leagueId ? LEAGUE_TO_SPORT[leagueId] ?? "" : "";
  const leagueLabel = leagueId || "all-league";
  const isDisabled = isLlmStub || hasNoEvidence;
  const running = run.phase === "running";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busyRef.current || isDisabled) return;
    busyRef.current = true;
    setRun({ phase: "running" });

    const res = await triggerTopicGeneration({ leagueId, sport, minScore });
    if (!res.success) {
      setRun({ phase: "done", kind: "error", title: "Couldn't start generation", detail: res.error });
      busyRef.current = false;
      return;
    }

    // Poll the real JobLog for THIS run's outcome (createdAt >= triggeredAt).
    const triggeredMs = res.triggeredAt ? Date.parse(res.triggeredAt) : Date.now();
    const deadline = Date.now() + 90_000;
    let resolved = false;
    while (Date.now() < deadline) {
      await sleep(2000);
      const logRes = await fetchLatestTopicGenerationLog();
      if (!logRes.success) continue;
      const log = logRes.log;
      if (!log) continue;
      const isThisRun = Date.parse(log.createdAt) >= triggeredMs - 5000;
      if (!isThisRun) continue;
      if (log.status === "running") continue;

      if (log.status === "failed") {
        setRun({ phase: "done", kind: "error", title: "Generation failed", detail: log.error || "See Job Logs for details." });
      } else {
        const out = log.output || {};
        const inserted = Number(out.insertedCount || 0);
        if (inserted > 0) {
          setRun({
            phase: "done",
            kind: "success",
            title: `Generated ${inserted} topic${inserted === 1 ? "" : "s"}`,
            detail: `${leagueId ? leagueId + " · " : ""}now available in the Unused tab.`,
          });
          onGenerated();
        } else {
          setRun({
            phase: "done",
            kind: "warning",
            title: "0 topics generated",
            detail: summarizeZeroInsert(out, leagueLabel),
          });
        }
      }
      resolved = true;
      break;
    }
    if (!resolved) {
      setRun({
        phase: "done",
        kind: "warning",
        title: "Still running",
        detail: "The job is taking longer than expected — check the Job Logs page for the result.",
      });
    }
    busyRef.current = false;
  };

  return (
    <div className="genPanel">
      <div className="genPanelHead">
        <h3 className="genPanelTitle">Generate candidates</h3>
        <p className="genPanelSub">Draft new debate topics from real ingested evidence. Sport follows the league.</p>
      </div>

      <form onSubmit={handleSubmit} className="genForm">
        <div className="genField">
          <label className="genLabel" htmlFor="leagueSelect">League</label>
          <select
            id="leagueSelect"
            className="genSelect"
            value={leagueId}
            onChange={(e) => setLeagueId(e.target.value)}
            disabled={running || isDisabled}
          >
            {LEAGUE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        <div className="genField">
          <label className="genLabel" htmlFor="sportDisplay">Target sport</label>
          <input
            id="sportDisplay"
            className="genInput genInputReadonly"
            type="text"
            value={leagueId ? sport : "All sports (no filter)"}
            readOnly
            disabled
            aria-describedby="sportHint"
          />
          <span id="sportHint" className="genHint">Derived from the league — can’t drift out of sync.</span>
        </div>

        <div className="genField">
          <label className="genLabel" htmlFor="minScoreInput">
            Minimum debate score <span className="genLabelValue">{minScore}</span>
          </label>
          <input
            id="minScoreInput"
            type="range"
            min={1}
            max={100}
            className="genRange"
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value))}
            disabled={running || isDisabled}
            aria-describedby="minScoreHint"
          />
          <span id="minScoreHint" className="genHint">Candidates scoring below this are dropped before insert.</span>
        </div>

        <button type="submit" className="genButton" disabled={running || isDisabled}>
          {running ? (
            <>
              <span className="genSpinner" aria-hidden="true" />
              Generating…
            </>
          ) : (
            "Generate topics"
          )}
        </button>

        {isDisabled && (
          <p className="genHint genHintWarn" role="status">
            {isLlmStub
              ? "LLM provider is set to stub — real generation is disabled."
              : "No ingested evidence yet — run Data Sources ingestion first."}
          </p>
        )}
      </form>

      {run.phase === "done" && (
        <div className={`genResult genResult--${run.kind}`} role="status" aria-live="polite">
          <span className="genResultIcon" aria-hidden="true">
            {run.kind === "success" ? "✓" : run.kind === "warning" ? "!" : "✕"}
          </span>
          <div className="genResultBody">
            <strong className="genResultTitle">{run.title}</strong>
            {run.detail && <span className="genResultDetail">{run.detail}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
