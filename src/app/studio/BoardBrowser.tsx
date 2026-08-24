import React from "react";
import Link from "next/link";
import BoardLogo from "./BoardLogo";

/**
 * The Board's league → conference → team drill-down.
 *
 * Deliberately plain links over URL state rather than a client-side tree: the
 * whole logo manifest is ~600 teams, and shipping it to the browser to power a
 * picker would cost more than every take on the page put together. Navigating
 * by href keeps the payload to the level actually on screen, makes every view
 * shareable and back-button-correct, and means the drill-down works before (and
 * without) hydration.
 *
 * This component is presentational — the page decides what a level contains.
 */

export interface BrowseCrumb {
  label: string;
  /** Absent on the current level, which is not a link. */
  href?: string;
  logo?: string;
  plate?: boolean;
  opaque?: boolean;
}

export interface BrowseTile {
  key: string;
  href: string;
  label: string;
  /** Conference short name, team count — one short line. */
  sublabel?: string;
  logo?: string;
  plate?: boolean;
  opaque?: boolean;
  monogram?: string;
  /** Takes waiting on this league / conference / team right now. */
  count: number;
  active?: boolean;
  /** Team primary colour, used for the tile's edge when it is chosen. */
  accent?: string;
}

export default function BoardBrowser({
  crumbs,
  tiles,
  label,
}: {
  crumbs: BrowseCrumb[];
  tiles: BrowseTile[];
  /** Names the grid for screen readers: "Leagues", "SEC teams". */
  label: string;
}) {
  // A trail whose only entry is the level you are already on navigates nowhere.
  // At the top of the board that was a lone "All leagues" rendered as a <span>,
  // sitting where the first crumb of a breadcrumb goes and doing nothing when
  // clicked — a dead control, and the only "All leagues" on the page. The
  // heading above already says what you are looking at, so a one-item trail
  // says nothing twice.
  const showTrail = crumbs.some((c) => c.href);

  return (
    <div className="boardBrowse">
      {showTrail && (
      <nav className="boardTrail" aria-label="Browse takes by team">
        {crumbs.map((c, i) => (
          <React.Fragment key={`${c.label}-${i}`}>
            {i > 0 && <span className="boardTrailSep" aria-hidden="true">›</span>}
            {c.href ? (
              // Plain <a> for the same reason as the shell's Back control: every
              // crumb points at a URL that differs from this one only by its
              // query string, which a soft navigation can serve from cache
              // without re-rendering the page. Tiles below go DOWN into a level
              // that was never cached, so those stay soft and instant.
              <a href={c.href} className="boardTrailLink">
                {c.logo && <BoardLogo src={c.logo} plate={c.plate} opaque={c.opaque} alt="" size="sm" />}
                {c.label}
              </a>
            ) : (
              <span className="boardTrailHere" aria-current="page">
                {c.logo && <BoardLogo src={c.logo} plate={c.plate} opaque={c.opaque} alt="" size="sm" />}
                {c.label}
              </span>
            )}
          </React.Fragment>
        ))}
      </nav>
      )}

      <ul className="boardTileGrid" aria-label={label}>
        {tiles.map((t) => (
          <li key={t.key}>
            <Link
              href={t.href}
              className={`boardTile${t.active ? " is-active" : ""}${t.count === 0 ? " is-quiet" : ""}`}
              aria-current={t.active ? "true" : undefined}
              data-testid="board-tile"
              data-tile={t.key}
              style={{ "--tile-accent": t.accent || "var(--border-hover)" } as React.CSSProperties}
            >
              <BoardLogo src={t.logo} plate={t.plate} opaque={t.opaque} monogram={t.monogram} alt="" size="lg" />
              <span className="boardTileLabel">{t.label}</span>
              {t.sublabel && <span className="boardTileSub">{t.sublabel}</span>}
              <span className={`boardTileCount${t.count === 0 ? " is-zero" : ""}`}>
                {t.count === 0 ? "No takes" : `${t.count} take${t.count === 1 ? "" : "s"}`}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
