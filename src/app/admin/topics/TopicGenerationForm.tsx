"use client";

import React, { useState } from "react";
import { triggerTopicGeneration } from "./actions";

interface FormProps {
  onTriggerSuccess: () => void;
  isLlmStub: boolean;
  hasNoEvidence: boolean;
}

export default function TopicGenerationForm({ onTriggerSuccess, isLlmStub, hasNoEvidence }: FormProps) {
  const [leagueId, setLeagueId] = useState("");
  const [sport, setSport] = useState("Basketball");
  const [minScore, setMinScore] = useState(50);

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

          {/* Sport Input */}
          <div className="formGroup">
            <label className="label" htmlFor="sportInput">Target Sport Name</label>
            <input
              type="text"
              id="sportInput"
              className="input"
              value={sport}
              onChange={(e) => setSport(e.target.value)}
              disabled={loading || isDisabled}
              required
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
              style={{ accentColor: "#38bdf8" }}
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
            style={{
              marginTop: "1rem",
              padding: "0.75rem",
              borderRadius: "4px",
              fontSize: "0.9rem",
              fontWeight: 500,
              backgroundColor: message.type === "success" ? "rgba(16, 185, 129, 0.1)" : "rgba(239, 68, 68, 0.1)",
              border: `1px solid ${message.type === "success" ? "rgba(16, 185, 129, 0.3)" : "rgba(239, 68, 68, 0.3)"}`,
              color: message.type === "success" ? "#10b981" : "#ef4444",
            }}
          >
            {message.text}
          </div>
        )}
      </div>
    </div>
  );
}
