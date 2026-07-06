"use client";

// Filter bar for Hot Topics. Every control writes to the URL query string
// (router.replace) so filtered views are shareable and the server component
// does the actual filtering.

import React from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";

const SCORE_OPTIONS = [
  { value: "", label: "Any heat" },
  { value: "60", label: "60+ heat" },
  { value: "75", label: "75+ heat" },
  { value: "90", label: "90+ heat" },
];

const RECENCY_OPTIONS = [
  { value: "", label: "All time" },
  { value: "24h", label: "Last 24h" },
  { value: "7d", label: "This week" },
  { value: "30d", label: "This month" },
];

const FOCUS_OPTIONS = [
  { value: "", label: "All angles" },
  { value: "betting", label: "🎲 Betting" },
  { value: "general", label: "🗣️ General" },
];

const SORT_OPTIONS = [
  { value: "", label: "Hottest first" },
  { value: "newest", label: "Newest first" },
  { value: "controversy", label: "Most controversial" },
  { value: "stars", label: "Biggest stars" },
  { value: "betting", label: "Betting heat" },
];

export default function TopicFilters({ sports }: { sports: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
  };

  const currentSport = params.get("sport") || "";
  const anyActive = ["sport", "minScore", "recency", "focus", "sort"].some((k) => params.get(k));

  return (
    <div className="uTopicFilters">
      <div className="uTopicFilterRow" role="group" aria-label="Filter by sport">
        <button type="button" className={`uWizChip ${currentSport === "" ? "sel" : ""}`} onClick={() => set("sport", "")}>
          All sports
        </button>
        {sports.map((s) => (
          <button
            key={s}
            type="button"
            className={`uWizChip ${currentSport.toLowerCase() === s.toLowerCase() ? "sel" : ""}`}
            aria-pressed={currentSport.toLowerCase() === s.toLowerCase()}
            onClick={() => set("sport", currentSport.toLowerCase() === s.toLowerCase() ? "" : s)}
          >
            {s}
          </button>
        ))}
      </div>
      <div className="uTopicFilterRow">
        <select className="uTopicSelect" aria-label="Minimum heat score" value={params.get("minScore") || ""} onChange={(e) => set("minScore", e.target.value)}>
          {SCORE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select className="uTopicSelect" aria-label="Recency" value={params.get("recency") || ""} onChange={(e) => set("recency", e.target.value)}>
          {RECENCY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select className="uTopicSelect" aria-label="Angle" value={params.get("focus") || ""} onChange={(e) => set("focus", e.target.value)}>
          {FOCUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select className="uTopicSelect" aria-label="Sort" value={params.get("sort") || ""} onChange={(e) => set("sort", e.target.value)}>
          {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {anyActive && (
          <button type="button" className="uTopicClear" onClick={() => router.replace(pathname, { scroll: false })}>
            ✕ Clear filters
          </button>
        )}
      </div>
    </div>
  );
}
