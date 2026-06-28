"use client";

import React, { useState } from "react";
import { triggerPodcastJob } from "./actions";

export default function JobTrigger() {
  const [episodeId, setEpisodeId] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!episodeId.trim()) return;

    setLoading(true);
    setMessage(null);

    const result = await triggerPodcastJob(episodeId.trim());

    if (result.success) {
      setMessage({
        type: "success",
        text: `Job queued successfully! Job ID: ${result.jobId}`,
      });
      setEpisodeId("");
    } else {
      setMessage({
        type: "error",
        text: result.error || "Failed to queue job.",
      });
    }
    setLoading(false);
  };

  return (
    <div className="panel">
      <div className="panelHeader">
        <h3 className="panelTitle">Queue Generation Job</h3>
      </div>
      <div className="panelContent">
        <form onSubmit={handleSubmit}>
          <div className="formGroup">
            <label className="label" htmlFor="episodeId">Episode ID / Name</label>
            <input
              type="text"
              id="episodeId"
              className="input"
              placeholder="e.g. ep-101-nba-finals"
              value={episodeId}
              onChange={(e) => setEpisodeId(e.target.value)}
              disabled={loading}
              required
            />
          </div>
          <button
            type="submit"
            className="buttonPrimary"
            disabled={loading || !episodeId.trim()}
          >
            {loading ? "Queueing..." : "Simulate Pipeline"}
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
