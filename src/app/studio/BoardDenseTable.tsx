import React from "react";
import Link from "next/link";
import BoardLogo from "./BoardLogo";
import { HeatBadge, type BoardTakeView } from "./BoardTakeCard";

/**
 * The scan-dense alternative to the card grid — same take data, one row
 * each. Exists for the same reason the grid does not scale past ~20 items:
 * a card spends 140px of height mostly on air (crest, badge, two blank
 * lines) that a row collapses into one. Not virtualized — the pool this
 * reads from is already bounded (POOL_CAP in page.tsx), so every row is
 * cheap DOM, not a perf problem. Wire in react-window here first if that
 * cap ever grows past a thousand or so rows.
 */
export default function BoardDenseTable({ takes }: { takes: BoardTakeView[] }) {
  return (
    <div className="boardTableWrap">
      <table className="boardTable">
        <thead>
          <tr>
            <th scope="col" className="boardTableHeatCol">Heat</th>
            <th scope="col">Take</th>
            <th scope="col" className="boardTableLeagueCol">League</th>
            <th scope="col">Why now</th>
            <th scope="col" className="boardTableActionCol"><span className="srOnly">Action</span></th>
          </tr>
        </thead>
        <tbody>
          {takes.map((t) => {
            const accent = t.crests[0]?.primary;
            return (
              <tr
                key={t.id}
                className="boardTableRow"
                style={{ "--take-accent": accent || "var(--border-hover)" } as React.CSSProperties}
                data-testid="board-take-row"
                data-take={t.id}
              >
                <td className="boardTableHeatCol">
                  <HeatBadge heat={t.heat} tier={t.tier} />
                </td>
                <td className="boardTableMain">
                  <span className="boardTableIdent">
                    {t.crests.slice(0, 2).map((c) => (
                      <BoardLogo key={`${c.leagueId}/${c.slug}`} src={c.logo} plate={c.plate} opaque={c.opaque} alt="" size="sm" />
                    ))}
                    <span className="boardTableTitle" title={t.title}>{t.title}</span>
                  </span>
                </td>
                <td className="boardTableLeagueCol">
                  <span className="chip">{t.leagueLabel ?? t.sport}</span>
                </td>
                <td className="boardTableWhy" title={t.whyNow ?? undefined}>{t.whyNow ?? "—"}</td>
                <td className="boardTableActionCol">
                  <Link href={`/studio/create?topic=${t.id}`} className="btnGhost boardTableAction">
                    Generate <span aria-hidden="true">→</span>
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
