"use client";

/**
 * The Board's search / sort / density controls, plus the feed they drive.
 *
 * Deliberately scoped to the REMAINDER below the hottest-three row (see the
 * comment on StudioBoard in page.tsx) — that remainder is where a board with
 * a healthy pool actually runs to 50+ cards, so it is what gets a search box,
 * a sort, and a table view. All state here is client-side and in-memory: the
 * server already fetched and sorted `takes`, so re-filtering/re-sorting a
 * few hundred rows in the browser is cheap, and it means the search box
 * responds on every keystroke rather than round-tripping the server the way
 * the league/conference/team drill-down (BoardBrowser) deliberately does.
 *
 * Default state (no query, heat sort, grid view) renders the exact same
 * heading and grid the un-enhanced list used to — see page.tsx for why that
 * matters.
 */

import React, { useMemo, useState } from "react";
import BoardTakeCard, { type BoardTakeView } from "./BoardTakeCard";
import BoardDenseTable from "./BoardDenseTable";

type SortMode = "heat" | "newest";
type ViewMode = "grid" | "table";

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function TableIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M3 10h18M3 15h18M9 4v16" />
    </svg>
  );
}

/** Free-text match over the fields actually shown on a card/row. */
function matches(t: BoardTakeView, q: string): boolean {
  const hay = [t.title, t.whyNow ?? "", t.leagueLabel ?? t.sport, ...t.crests.map((c) => c.name)]
    .join(" \n ")
    .toLowerCase();
  return hay.includes(q);
}

export default function BoardControls({
  takes,
  scopeHeading,
  scopeLabel,
  scopedCount,
  totalCount,
}: {
  /** Server-scoped, server-sorted (heat desc) — everything below the
   *  hottest three, at whatever league/conference/team is selected. */
  takes: BoardTakeView[];
  scopeHeading: string | null;
  scopeLabel: string | null;
  /** scoped.length from the page — the hottest three PLUS this remainder. */
  scopedCount: number;
  /** takes.length from the page — the whole board pool, unscoped. */
  totalCount: number;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("heat");
  const [view, setView] = useState<ViewMode>("grid");

  const searching = query.trim().length > 0;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = q ? takes.filter((t) => matches(t, q)) : takes;
    // "heat" needs no re-sort: `takes` arrives already sorted that way, and
    // filtering preserves order.
    if (sort === "newest") {
      return [...rows].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }
    return rows;
  }, [takes, query, sort]);

  return (
    <>
      <div className="boardControlBar">
        <label className="boardSearchField">
          <span className="srOnly">Search takes, teams, or leagues</span>
          <SearchIcon />
          <input
            type="search"
            className="input boardSearchInput"
            placeholder="Search takes, teams, leagues…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>

        <label className="boardSortField">
          <span className="srOnly">Sort takes by</span>
          <select
            className="select boardControlSelect"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortMode)}
          >
            <option value="heat">Sort: Blazing first</option>
            <option value="newest">Sort: Newest first</option>
          </select>
        </label>

        <div className="boardViewToggle" role="group" aria-label="Feed layout">
          <button
            type="button"
            className={`boardViewBtn${view === "grid" ? " is-active" : ""}`}
            aria-pressed={view === "grid"}
            onClick={() => setView("grid")}
          >
            <GridIcon />
            Grid
          </button>
          <button
            type="button"
            className={`boardViewBtn${view === "table" ? " is-active" : ""}`}
            aria-pressed={view === "table"}
            onClick={() => setView("table")}
          >
            <TableIcon />
            Table
          </button>
        </div>
      </div>

      <div className="sectionHead">
        <h2 className="sectionTitle">
          {searching
            ? `${filtered.length} match${filtered.length === 1 ? "" : "es"} for "${query.trim()}"`
            : scopeHeading
              ? `More ${scopeHeading} takes`
              : "The rest of the board"}
        </h2>
        {!searching && scopeLabel && (
          <span className="sectionCount">{scopedCount} of {totalCount}</span>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="emptyNote">
          {`No takes match "${query.trim()}". Try a different team, league, or word.`}
        </div>
      ) : view === "grid" ? (
        <div className="boardGrid">
          {filtered.map((t) => (
            <BoardTakeCard key={t.id} take={t} />
          ))}
        </div>
      ) : (
        <BoardDenseTable takes={filtered} />
      )}
    </>
  );
}
