"use client";

import React, { useState } from "react";
import { triggerDataIngestion } from "./actions";

interface FormProps {
  onTriggerSuccess: () => void;
}

export default function IngestionTriggerForm({ onTriggerSuccess }: FormProps) {
  const [providerType, setProviderType] = useState("sportsdataio");
  const [leagueId, setLeagueId] = useState("NFL");
  const [sport, setSport] = useState("");
  const [dateOrRange, setDateOrRange] = useState("");

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

    const res = await triggerDataIngestion({
      providerType,
      leagueId: providerType === "rss-news" ? "" : leagueId,
      sport,
      dateOrRange,
    });

    if (res.success) {
      setMessage({
        type: "success",
        text: `Ingestion job queued! Job ID: ${res.jobId}. Check worker terminal and logs below.`,
      });
      // Clear inputs
      setSport("");
      setDateOrRange("");
      // Call parent refresh callback
      setTimeout(() => {
        onTriggerSuccess();
      }, 1000);
    } else {
      setMessage({
        type: "error",
        text: res.error || "Failed to trigger ingestion.",
      });
    }
    setLoading(false);
  };

  const handleProviderChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setProviderType(val);
    if (val === "rss-news") {
      setLeagueId("");
    } else if (leagueId === "") {
      setLeagueId("NFL");
    }
  };

  return (
    <div className="panel">
      <div className="panelHeader">
        <h3 className="panelTitle">Trigger Manual Ingestion</h3>
      </div>
      <div className="panelContent">
        <form onSubmit={handleSubmit} className="form">
          {/* Provider Selection */}
          <div className="formGroup">
            <label className="label" htmlFor="providerSelect">Select Ingestion Provider</label>
            <select
              id="providerSelect"
              className="select"
              value={providerType}
              onChange={handleProviderChange}
              disabled={loading}
            >
              <option value="sportsdataio">SportsDataIO API</option>
              <option value="oddsapi">The Odds API</option>
              <option value="rss-news">RSS/News Feed Ingest</option>
              <option value="stub">Stub Validation Provider</option>
            </select>
          </div>

          {/* League Selection */}
          {providerType !== "rss-news" && (
            <div className="formGroup">
              <label className="label" htmlFor="leagueSelect">Target League</label>
              <select
                id="leagueSelect"
                className="select"
                value={leagueId}
                onChange={(e) => setLeagueId(e.target.value)}
                disabled={loading}
              >
                <option value="NFL">NFL (National Football League)</option>
                <option value="NBA">NBA (National Basketball Association)</option>
                <option value="MLB">MLB (Major League Baseball)</option>
                <option value="NCAAF">NCAAF (NCAA College Football)</option>
                <option value="NCAAB">NCAAB (NCAA College Basketball)</option>
                <option value="MMA">MMA (Mixed Martial Arts / UFC)</option>
              </select>
            </div>
          )}

          {/* Sport parameter (mainly for Odds API custom keys) */}
          {providerType === "oddsapi" && (
            <div className="formGroup">
              <label className="label" htmlFor="sportInput">Custom Sport Key (Optional)</label>
              <input
                type="text"
                id="sportInput"
                className="input"
                placeholder="e.g. americanfootball_nfl"
                value={sport}
                onChange={(e) => setSport(e.target.value)}
                disabled={loading}
              />
              <span className="helperText" style={{ color: "var(--text-secondary)", fontSize: "0.75rem", marginTop: "0.15rem" }}>
                Leave blank to automatically map from selection above.
              </span>
            </div>
          )}

          {/* Date range / Season parameter */}
          {providerType !== "rss-news" && providerType !== "stub" && (
            <div className="formGroup">
              <label className="label" htmlFor="dateOrRangeInput">
                {providerType === "sportsdataio" ? "Season / Target Date (Optional)" : "Date Parameter (Optional)"}
              </label>
              <input
                type="text"
                id="dateOrRangeInput"
                className="input"
                placeholder={providerType === "sportsdataio" ? "e.g. 2026 or 2026-OCT-28" : "e.g. recent"}
                value={dateOrRange}
                onChange={(e) => setDateOrRange(e.target.value)}
                disabled={loading}
              />
              <span className="helperText" style={{ color: "var(--text-secondary)", fontSize: "0.75rem", marginTop: "0.15rem" }}>
                Default: Season 2026 or current date.
              </span>
            </div>
          )}

          <button
            type="submit"
            className="buttonPrimary"
            disabled={loading}
          >
            {loading ? "Queueing Ingestion..." : "Start Ingestion"}
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
