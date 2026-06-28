import React from "react";
import IngestionDashboard from "./IngestionDashboard";
import { fetchIngestionStats, fetchRecentJobLogs } from "./actions";
import "./data-sources.css";

// Force Next.js to server-render on demand
export const dynamic = "force-dynamic";

export default async function DataSourcesPage() {
  // Fetch initial stats and logs server-side
  const statsRes = await fetchIngestionStats();
  const logsRes = await fetchRecentJobLogs();

  const initialStats = statsRes.success && statsRes.stats ? statsRes.stats : {
    leagues: 0,
    teams: 0,
    players: 0,
    games: 0,
    odds: 0,
    injuries: 0,
    news: 0,
    stats: 0,
  };

  const initialLogs = logsRes.success && logsRes.logs ? logsRes.logs : [];

  // API Configurations Check
  const sportsProvider = process.env.SPORTS_PROVIDER || "stub";
  const hasSportsdataioKey = !!process.env.SPORTSDATAIO_API_KEY && process.env.SPORTSDATAIO_API_KEY !== "your-sportsdataio-api-key";
  const hasOddsapiKey = !!process.env.THEODDSAPI_API_KEY && process.env.THEODDSAPI_API_KEY !== "your-theoddsapi-api-key";
  const hasRssConfig = !!process.env.RSS_NEWS_FEEDS;

  const providersConfig = {
    sportsProvider,
    hasSportsdataioKey,
    hasOddsapiKey,
    hasRssConfig,
  };

  return (
    <div className="formContainer" style={{ maxWidth: "100%" }}>
      {/* Page Header */}
      <div className="dataSourcesHeader">
        <div className="titleGroup">
          <h2>Sports Data Ingestion Control Center</h2>
          <p>Monitor evidence data pipelines, trigger sync jobs, and track provider integration logs.</p>
        </div>
      </div>

      {/* Main Dashboard Wrapper */}
      <IngestionDashboard
        initialStats={initialStats}
        initialLogs={initialLogs}
        providersConfig={providersConfig}
      />
    </div>
  );
}
