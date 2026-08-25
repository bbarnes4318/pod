import React from "react";
import Link from "next/link";
import BoardLogo from "./BoardLogo";

/** A team the take is about, resolved from the take's own evidence. */
export interface TakeCrest {
  leagueId: string;
  slug: string;
  name: string;
  logo: string;
  plate: boolean;
  opaque: boolean;
  primary?: string;
}

export interface BoardTakeView {
  id: string;
  title: string;
  /** Sport as the pipeline stored it — always present. */
  sport: string;
  /** "NFL" / "College Football", when the take carries a league. */
  leagueLabel: string | null;
  heat: number;
  tier: { key: string; label: string };
  whyNow: string | null;
  crests: TakeCrest[];
  /** ISO timestamp — carried through for the "Newest" sort and the dense
   *  table's age column. Not shown on the card itself. */
  createdAt: string;
}

function FlameIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3c1.6 3.2 4.2 4.7 4.2 8.2A4.2 4.2 0 0 1 12 15.4a4.2 4.2 0 0 1-4.2-4.2c0-1.3.4-2.4 1.1-3.2.2 1.1.9 1.8 1.6 2C10.6 8 10.5 5.3 12 3Z" />
      <path d="M12 21a5 5 0 0 0 5-5c0-1.6-.8-2.9-1.7-3.9.1 2.3-1.3 3.6-2.6 4.1.4-1.3.1-2.7-1.2-4-1.2 1-2 2.3-2 3.8a5 5 0 0 0 4.5 5Z" opacity="0.55" />
    </svg>
  );
}

/**
 * Heat badge — icon + label + score + colour together, so the tier never
 * depends on colour alone. Signal Orange stays reserved for Generate / live.
 */
export function HeatBadge({ heat, tier }: { heat: number; tier: { key: string; label: string } }) {
  return (
    <span className={`heatBadge heat-${tier.key}`} title={`Debate heat ${heat} of 100`}>
      <FlameIcon />
      <span className="heatLabel">{tier.label}</span>
      <span className="heatScore" aria-label={`heat ${heat} of 100`}>{heat}</span>
    </span>
  );
}

/** The crests, side by side. Decorative: .boardTeamChips below names every
 *  team on the take, so alt text here would only repeat it. */
function Crests({ crests, size }: { crests: TakeCrest[]; size: "sm" | "md" }) {
  if (crests.length === 0) return null;
  // Two is the natural cap: a take is usually one team or a matchup, and a
  // third crest crowds the card without telling you anything new.
  const shown = crests.slice(0, 2);
  const extra = crests.length - shown.length;
  return (
    <span className="takeCrests">
      {shown.map((c) => (
        <BoardLogo key={`${c.leagueId}/${c.slug}`} src={c.logo} plate={c.plate} opaque={c.opaque} alt="" size={size} />
      ))}
      {extra > 0 && <span className="takeCrestMore">+{extra}</span>}
    </span>
  );
}

/** Teams as small pills instead of a wrapped/truncated line of plain text —
 *  scannable at a glance, and the overflow chip matches the crest cap above
 *  so the two rows never disagree about how many teams there are. */
function TeamChips({ crests }: { crests: TakeCrest[] }) {
  if (crests.length === 0) return null;
  const shown = crests.slice(0, 2);
  const extra = crests.length - shown.length;
  return (
    <span className="boardTeamChips">
      {shown.map((c) => (
        <span key={`${c.leagueId}/${c.slug}`} className="boardTeamChip">{c.name}</span>
      ))}
      {extra > 0 && <span className="boardTeamChip boardTeamChip--more">+{extra} more</span>}
    </span>
  );
}

export default function BoardTakeCard({
  take,
  featured = false,
  rank,
}: {
  take: BoardTakeView;
  /** The hero treatment used by the "hottest right now" row. Solid, high-
   *  contrast Generate CTA is reserved for this state — every other card
   *  gets the quiet outline action below. */
  featured?: boolean;
  /** 1-based position, shown on featured cards only. */
  rank?: number;
}) {
  const accent = take.crests[0]?.primary;

  return (
    <article
      className={`studioCard boardCard${featured ? " boardCard--featured" : ""}`}
      style={{ "--take-accent": accent || "var(--border-hover)" } as React.CSSProperties}
      data-testid={featured ? "board-featured-take" : "board-take"}
      data-take={take.id}
    >
      <div className="boardCardTop">
        <span className="boardCardIdent">
          {featured && rank != null && <span className="boardRank" aria-hidden="true">{rank}</span>}
          <Crests crests={take.crests} size={featured ? "md" : "sm"} />
          <span className="chip">{take.leagueLabel ?? take.sport}</span>
        </span>
        <HeatBadge heat={take.heat} tier={take.tier} />
      </div>

      <h3 className="epTitle boardCardTitle">{take.title}</h3>

      <TeamChips crests={take.crests} />

      {take.whyNow && (
        <p className="boardWhy">
          <span className="boardWhyLabel">Why now</span>
          {take.whyNow}
        </p>
      )}

      <div className="boardCardFoot">
        {/* ONE solid CTA on the page, not three.
            Every featured card took .btnPrimary, so the hottest row fired three
            identical solid-orange buttons side by side — plus "Generate" in the
            topbar, which is four primary actions competing on one screen. The
            row is RANKED, and a ranking that only shows in a small 1/2/3
            numeral is not a ranking anyone reads. #1 keeps the solid fill and
            carries the eye; #2 and #3 drop to the same quiet outline as the
            rest of the board, so the order is visible in the weight instead of
            only in the digit. */}
        <Link
          href={`/studio/create?topic=${take.id}`}
          className={
            featured && rank === 1
              ? "btnPrimary boardGenBtn"
              : "btnGhost boardGenBtn boardGenBtn--quiet"
          }
        >
          Generate Episode
        </Link>
      </div>
    </article>
  );
}
