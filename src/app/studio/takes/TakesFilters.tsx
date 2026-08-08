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

  return (
    <div className="takeFilters">
      <label className="takeFilter">
        <span className="takeFilterLabel">
          Sport
        </span>
        <select
          aria-label="Filter by sport"
          value={currentSport}
          onChange={(e) => set("sport", e.target.value)}
          className="takeSelect"
        >
          <option value="">All sports</option>
          {sports.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </label>

      <label className="takeFilter">
        <span className="takeFilterLabel">
          League
        </span>
        <select
          aria-label="Filter by league"
          value={currentLeague}
          onChange={(e) => set("league", e.target.value)}
          className="takeSelect"
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
          className="takeSelect takeFilterClear"
        >
          ✕ Clear
        </button>
      )}
    </div>
  );
}
