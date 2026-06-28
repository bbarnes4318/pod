"use client";

import React, { useState, useEffect } from "react";
import IngestionTriggerForm from "./IngestionTriggerForm";
import { fetchIngestionStats, fetchRecentJobLogs } from "./actions";

interface DashboardProps {
  initialStats: {
    leagues: number;
    teams: number;
    players: number;
    games: number;
    odds: number;
    injuries: number;
    news: number;
    stats: number;
  };
  initialLogs: any[];
  providersConfig: {
    sportsProvider: string;
    hasSportsdataioKey: boolean;
    hasOddsapiKey: boolean;
    hasRssConfig: boolean;
  };
}

export default function IngestionDashboard({ initialStats, initialLogs, providersConfig }: DashboardProps) {
  const [stats, setStats] = useState(initialStats);
  const [logs, setLogs] = useState(initialLogs);
  const [isStubActive, setIsStubActive] = useState(providersConfig.sportsProvider.toLowerCase() === "stub");

  const refreshData = async () => {
    const statsRes = await fetchIngestionStats();
    if (statsRes.success && statsRes.stats) {
      setStats(statsRes.stats);
    }
    const logsRes = await fetchRecentJobLogs();
    if (logsRes.success && logsRes.logs) {
      setLogs(logsRes.logs);
    }
  };

  // Poll for logs updates every 5 seconds to show real-time progress of worker
  useEffect(() => {
    const interval = setInterval(refreshData, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div>
      {/* 1. STUB WARNING BANNER */}
      {isStubActive && (
        <div className="warningBanner">
          <strong>⚠️ Stub provider active — real sports ingestion disabled.</strong>
          <p style={{ marginTop: "0.25rem", color: "rgba(245, 158, 11, 0.85)" }}>
            The application is configured to run in architecture validation mode. Ingestion requests will complete as empty no-ops and no real sports records will be added to the database. To enable ingestion, change <code>SPORTS_PROVIDER</code> to a real provider in your environment variables.
          </p>
        </div>
      )}

      {/* 2. PROVIDERS API STATUS ROW */}
      <div className="grid" style={{ marginBottom: "2rem" }}>
        {/* SportsDataIO */}
        <div className="providerCard">
          <div className="providerCardHeader">
            <span className="providerName">SportsDataIO API</span>
            <span className="providerTypeBadge">Core Data</span>
          </div>
          <div className="providerDetails">
            <div className="providerDetailRow">
              <span className="detailLabel">API Key Status:</span>
              <span className={providersConfig.hasSportsdataioKey ? "detailValueActive" : "detailValueInactive"}>
                {providersConfig.hasSportsdataioKey ? "CONFIGURED" : "MISSING"}
              </span>
            </div>
            <div className="providerDetailRow">
              <span className="detailLabel">Configured Leagues:</span>
              <span className="detailValue">NFL, NBA, MLB</span>
            </div>
          </div>
        </div>

        {/* The Odds API */}
        <div className="providerCard">
          <div className="providerCardHeader">
            <span className="providerName">The Odds API</span>
            <span className="providerTypeBadge">Betting Markets</span>
          </div>
          <div className="providerDetails">
            <div className="providerDetailRow">
              <span className="detailLabel">API Key Status:</span>
              <span className={providersConfig.hasOddsapiKey ? "detailValueActive" : "detailValueInactive"}>
                {providersConfig.hasOddsapiKey ? "CONFIGURED" : "MISSING"}
              </span>
            </div>
            <div className="providerDetailRow">
              <span className="detailLabel">Tied Back Games:</span>
              <span className="detailValue">Strict matching required</span>
            </div>
          </div>
        </div>

        {/* RSS News */}
        <div className="providerCard">
          <div className="providerCardHeader">
            <span className="providerName">RSS News Feed Ingest</span>
            <span className="providerTypeBadge">Headline News</span>
          </div>
          <div className="providerDetails">
            <div className="providerDetailRow">
              <span className="detailLabel">Feed URL Status:</span>
              <span className={providersConfig.hasRssConfig ? "detailValueActive" : "detailValueInactive"}>
                {providersConfig.hasRssConfig ? "CONFIGURED" : "MISSING"}
              </span>
            </div>
            <div className="providerDetailRow">
              <span className="detailLabel">Storage Limit:</span>
              <span className="detailValue">Headlines only (no copyrighted text)</span>
            </div>
          </div>
        </div>
      </div>

      {/* 3. DATABASE INGEST STATISTICS GRID */}
      <h3 style={{ marginBottom: "1rem", color: "#ffffff", fontSize: "1.1rem" }}>Current Stored Evidence Statistics</h3>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", marginBottom: "2rem" }}>
        <div className="card" style={{ padding: "1.25rem" }}>
          <div className="cardTitle" style={{ fontSize: "0.75rem" }}>Registered Leagues</div>
          <div className="cardValue" style={{ fontSize: "1.6rem" }}>{stats.leagues}</div>
        </div>
        <div className="card" style={{ padding: "1.25rem" }}>
          <div className="cardTitle" style={{ fontSize: "0.75rem" }}>Total Teams</div>
          <div className="cardValue" style={{ fontSize: "1.6rem" }}>{stats.teams}</div>
        </div>
        <div className="card" style={{ padding: "1.25rem" }}>
          <div className="cardTitle" style={{ fontSize: "0.75rem" }}>Total Players</div>
          <div className="cardValue" style={{ fontSize: "1.6rem" }}>{stats.players}</div>
        </div>
        <div className="card" style={{ padding: "1.25rem" }}>
          <div className="cardTitle" style={{ fontSize: "0.75rem" }}>Ingested Games</div>
          <div className="cardValue" style={{ fontSize: "1.6rem" }}>{stats.games}</div>
        </div>
        <div className="card" style={{ padding: "1.25rem" }}>
          <div className="cardTitle" style={{ fontSize: "0.75rem" }}>Odds Snapshots</div>
          <div className="cardValue" style={{ fontSize: "1.6rem" }}>{stats.odds}</div>
        </div>
        <div className="card" style={{ padding: "1.25rem" }}>
          <div className="cardTitle" style={{ fontSize: "0.75rem" }}>Active Injuries</div>
          <div className="cardValue" style={{ fontSize: "1.6rem" }}>{stats.injuries}</div>
        </div>
        <div className="card" style={{ padding: "1.25rem" }}>
          <div className="cardTitle" style={{ fontSize: "0.75rem" }}>News Items</div>
          <div className="cardValue" style={{ fontSize: "1.6rem" }}>{stats.news}</div>
        </div>
        <div className="card" style={{ padding: "1.25rem" }}>
          <div className="cardTitle" style={{ fontSize: "0.75rem" }}>Season Stats</div>
          <div className="cardValue" style={{ fontSize: "1.6rem" }}>{stats.stats}</div>
        </div>
      </div>

      {/* 4. LAYOUT SPLIT SECTION */}
      <div className="sectionLayout">
        {/* Left Side: Controls */}
        <IngestionTriggerForm onTriggerSuccess={refreshData} />

        {/* Right Side: Log Tracker */}
        <div className="panel">
          <div className="panelHeader">
            <h3 className="panelTitle">Ingestion Job Logs</h3>
            <button
              onClick={refreshData}
              className="editButton"
              style={{ padding: "0.25rem 0.75rem", fontSize: "0.8rem" }}
            >
              Refresh Logs
            </button>
          </div>
          <div className="panelContent" style={{ padding: 0 }}>
            {logs.length === 0 ? (
              <div style={{ textAlign: "center", padding: "3rem", color: "#64748b" }}>
                No ingestion job logs found in database.
              </div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Job ID</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Output Details / Count</th>
                    <th>Captured Time</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => {
                    const output = log.output || {};
                    const counts = output.counts || {};
                    const details = log.error
                      ? `Error: ${log.error}`
                      : output.message
                      ? output.message
                      : `Ingested: games=${counts.games || 0}, news=${counts.news || 0}, odds=${counts.odds || 0}, injuries=${counts.injuries || 0}`;

                    return (
                      <tr key={log.id}>
                        <td>
                          <code className="logCode" style={{ color: "#38bdf8" }}>{log.id.substring(0, 8)}...</code>
                        </td>
                        <td>
                          <code className="logCode">{log.jobType}</code>
                        </td>
                        <td>
                          <span
                            className={`badge ${
                              log.status === "running"
                                ? "badgeRunning"
                                : log.status === "completed"
                                ? "badgeCompleted"
                                : "badgeFailed"
                            }`}
                          >
                            {log.status}
                          </span>
                        </td>
                        <td style={{ fontSize: "0.85rem", color: log.status === "failed" ? "#ef4444" : "#cbd5e1" }}>
                          {details}
                        </td>
                        <td style={{ fontSize: "0.8rem", color: "#64748b" }}>
                          {new Date(log.createdAt).toLocaleString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
