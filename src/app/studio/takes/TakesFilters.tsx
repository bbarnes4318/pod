"use client";

// Sport / League filter bar for the studio takes board. Each control writes to
// the URL query string (router.replace) so the server component does the real
// filtering and filtered views stay shareable/back-button friendly.

import React from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";

export interface LeagueOption {
  id: string;
  name: string;
}

export default function TakesFilters({
  sports,
  leagues,
}: {
  sports: string[];
  leagues: LeagueOption[];
}) {
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
  const currentLeague = params.get("league") || "";
  const anyActive = !!(currentSport || currentLeague);

  const selectStyle: React.CSSProperties = {
    background: "var(--surface-2, rgba(255,255,255,0.04))",
    color: "var(--text, inherit)",
    border: "1px solid var(--border, rgba(255,255,255,0.14))",
    borderRadius: 8,
    padding: "0.45rem 0.7rem",
    fontSize: "0.82rem",
    fontFamily: "inherit",
  };

  return (
    <div
      style={{
        display: "flex",
        gap: "0.9rem",
        alignItems: "flex-end",
        flexWrap: "wrap",
        margin: "0.25rem 0 1.25rem",
      }}
    >
      <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <span style={{ fontSize: "0.68rem", color: "var(--text-secondary)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>
          Sport
        </span>
        <select
          aria-label="Filter by sport"
          value={currentSport}
          onChange={(e) => set("sport", e.target.value)}
          style={selectStyle}
        >
          <option value="">All sports</option>
          {sports.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <span style={{ fontSize: "0.68rem", color: "var(--text-secondary)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>
          League
        </span>
        <select
          aria-label="Filter by league"
          value={currentLeague}
          onChange={(e) => set("league", e.target.value)}
          style={selectStyle}
        >
          <option value="">All leagues</option>
          {leagues.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
      </label>

      {anyActive && (
        <button
          type="button"
          onClick={() => router.replace(pathname, { scroll: false })}
          style={{
            ...selectStyle,
            cursor: "pointer",
            color: "var(--text-secondary)",
          }}
        >
          ✕ Clear
        </button>
      )}
    </div>
  );
}
