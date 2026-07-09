"use client";

import React, { useState } from "react";
import { triggerTopicGeneration } from "./actions";

interface FormProps {
  onTriggerSuccess: () => void;
  isLlmStub: boolean;
  hasNoEvidence: boolean;
}

// The sport the generator must match is DERIVED from the selected league so the
// two can never disagree. Previously the sport was a separate free-text field
// defaulting to "Basketball"; picking (e.g.) MLB left sport="Basketball", and
// the worker rejected every MLB/Baseball candidate as a sport mismatch
// (worker.ts handleTopicGeneration). Keys match the league <option> values.
const LEAGUE_TO_SPORT: Record<string, string> = {
  NFL: "Football",
  NBA: "Basketball",
  MLB: "Baseball",
  NCAAF: "Football",
  NCAAB: "Basketball",
  MMA: "Combat Sports",
};

export default function TopicGenerationForm({ onTriggerSuccess, isLlmStub, hasNoEvidence }: FormProps) {
  const [leagueId, setLeagueId] = useState("");
  const [minScore, setMinScore] = useState(50);
  // Empty when "All Leagues" is selected → the worker applies no sport/league
  // constraint and generates across every league's evidence.
  const sport = leagueId ? LEAGUE_TO_SPORT[leagueId] ?? "" : "";

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

    const res = await triggerTopicGeneration({
      leagueId,
      sport,
      minScore,
    });

    if (res.success) {
      setMessage({
        type: "success",
        text: `Topic generation job queued! Job ID: ${res.jobId}. Check worker terminal and logs below.`,
      });
      setTimeout(() => {
        onTriggerSuccess();
      }, 1000);
    } else {
      setMessage({
        type: "error",
        text: res.error || "Failed to trigger generation.",
      });
    }
    setLoading(false);
  };

  const isDisabled = isLlmStub || hasNoEvidence;

  return (
    <div className="panel">
      <div className="panelHeader">
        <h3 className="panelTitle">Generate Candidates</h3>
      </div>
      <div className="panelContent">
        <form onSubmit={handleSubmit} className="form">
          {/* League Select */}
          <div className="formGroup">
            <label className="label" htmlFor="leagueSelect">Filter League</label>
            <select
              id="leagueSelect"
              className="select"
              value={leagueId}
              onChange={(e) => setLeagueId(e.target.value)}
              disabled={loading || isDisabled}
            >
              <option value="">All Leagues</option>
              <option value="NFL">NFL (National Football League)</option>
              <option value="NBA">NBA (National Basketball Association)</option>
              <option value="MLB">MLB (Major League Baseball)</option>
              <option value="NCAAF">NCAAF (NCAA College Football)</option>
              <option value="NCAAB">NCAAB (NCAA College Basketball)</option>
              <option value="MMA">MMA (Mixed Martial Arts / UFC)</option>
            </select>
          </div>

          {/* Target sport — derived from the league above, shown read-only so it
              can't drift out of sync with the selection. */}
          <div className="formGroup">
            <label className="label" htmlFor="sportDisplay">Target Sport (from league)</label>
            <input
              type="text"
              id="sportDisplay"
              className="input"
              value={leagueId ? sport : "All sports (no filter)"}
              readOnly
              disabled
            />
          </div>

          {/* Min Debate Score */}
          <div className="formGroup">
            <label className="label" htmlFor="minScoreInput">Minimum Debate Score ({minScore})</label>
            <input
              type="range"
              id="minScoreInput"
              min="1"
              max="100"
              className="rangeInput"
              style={{ accentColor: "var(--accent-color)", width: "100%" }}
              value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))}
              disabled={loading || isDisabled}
            />
          </div>

          <button
            type="submit"
            className="buttonPrimary"
            disabled={loading || isDisabled}
          >
            {loading ? "Queueing Generator..." : "Generate Topics"}
          </button>
        </form>

        {message && (
          <div
            className={`alertCard ${message.type === "success" ? "alertSuccess" : "alertDanger"}`}
            style={{ marginTop: "1rem", marginBottom: 0 }}
          >
            {message.text}
          </div>
        )}
      </div>
    </div>
  );
}
