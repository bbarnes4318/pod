// Gambling responsible-marketing guardrails. This is a HARD publish
// requirement for betting-adjacent content, enforced server-side inside
// validateEpisodeForRss — not a UI checkbox. A betting-content episode cannot
// publish unless the responsible-gambling disclaimer + helpline is present in
// the show notes and none of the prohibited profit-promise phrases appear in
// the published-facing text. Non-betting episodes are unaffected.

import { topicMatchesVertical } from "@/lib/verticals";

/** The disclaimer that must appear in a betting episode's show notes. The
 *  helpline number doubles as the presence marker the gate checks for. */
export const RESPONSIBLE_GAMBLING_HELPLINE = "1-800-GAMBLER";
export const RESPONSIBLE_GAMBLING_DISCLAIMER = [
  "## Responsible gaming",
  "",
  "21+ and present in a state where betting is legal. If you or someone you know has a gambling problem, help is available: call **1-800-GAMBLER** (1-800-426-2537) or visit ncpgambling.org.",
  "",
  "This episode is sports commentary and entertainment, not betting advice. Nothing here is a prediction, guarantee, or recommendation to place a wager. Bet responsibly; only wager what you can afford to lose.",
].join("\n");

/** Profit-promise / "risk-free" language that must never ship in the published
 *  marketing text of a betting episode. */
const PROHIBITED_PATTERNS: { label: string; re: RegExp }[] = [
  { label: "risk-free", re: /\brisk[\s-]?free\b/i },
  { label: "guaranteed win/profit", re: /\bguarantee(?:d|s)?\b(?:[^.\n]{0,30})?\b(?:win|winner|profit|money|payout|cash|return)?/i },
  { label: "can't lose", re: /\b(?:can'?t|cannot|no way to)\s+lose\b/i },
  { label: "sure thing / lock", re: /\b(?:sure\s+thing|guaranteed\s+lock|lock\s+of\s+the\s+(?:day|week|year|century))\b/i },
  { label: "free/easy money", re: /\b(?:free|easy)\s+money\b/i },
  { label: "100% win", re: /\b100%\s*(?:win|lock|guaranteed)\b/i },
  { label: "get rich", re: /\bget\s+rich\b/i },
];

export interface ProhibitedHit {
  label: string;
  match: string;
}

/** Scan published-facing text for prohibited profit-promise language. */
export function scanProhibitedGamblingLanguage(text: string | null | undefined): ProhibitedHit[] {
  if (!text) return [];
  const hits: ProhibitedHit[] = [];
  for (const p of PROHIBITED_PATTERNS) {
    const m = text.match(p.re);
    if (m) hits.push({ label: p.label, match: m[0].trim() });
  }
  return hits;
}

/** Is the responsible-gambling disclaimer present in the show notes? Anchored
 *  on the helpline number so the exact wording can vary but the helpline can't
 *  be dropped. */
export function hasResponsibleGamblingDisclaimer(showNotes: string | null | undefined): boolean {
  if (!showNotes) return false;
  const t = showNotes.toLowerCase();
  return t.includes("1-800-gambler") || t.includes("1-800-426-2537") || t.includes("ncpgambling.org");
}

export interface BettingTopicShape {
  title: string;
  summary?: string | null;
  leagueId?: string | null;
  bettingRelevanceScore?: number | null;
}

/**
 * Does this episode contain betting / point-spread content? True if its podcast
 * is tagged to the gambling vertical, or ANY of its topics reads as betting
 * (GAMBLING league, betting-relevance ≥ 60, or the betting keyword regex — the
 * exact test the vertical matcher uses).
 */
export function episodeHasBettingContent(params: {
  podcastVerticals?: string[] | null;
  topics: BettingTopicShape[];
}): boolean {
  if (params.podcastVerticals?.includes("Gambling/Point Spread")) return true;
  return (params.topics || []).some((t) =>
    topicMatchesVertical(
      { title: t.title, summary: t.summary ?? null, leagueId: t.leagueId ?? null, bettingRelevanceScore: t.bettingRelevanceScore ?? null },
      "Gambling/Point Spread"
    )
  );
}

export interface GamblingComplianceResult {
  betting: boolean;
  compliant: boolean;
  reasons: string[];
  prohibited: ProhibitedHit[];
  disclaimerPresent: boolean;
}

/**
 * The gate. For betting content the show notes MUST carry the disclaimer and
 * the published-facing text MUST be free of prohibited language. Returns the
 * blockers; the caller (validateEpisodeForRss) refuses publish on any.
 */
export function checkGamblingCompliance(params: {
  betting: boolean;
  showNotes: string | null | undefined;
  marketingText: string; // title + summary + show notes — what listeners see
}): GamblingComplianceResult {
  if (!params.betting) {
    return { betting: false, compliant: true, reasons: [], prohibited: [], disclaimerPresent: true };
  }
  const disclaimerPresent = hasResponsibleGamblingDisclaimer(params.showNotes);
  const prohibited = scanProhibitedGamblingLanguage(params.marketingText);
  const reasons: string[] = [];
  if (!disclaimerPresent) {
    reasons.push(`Betting content requires a responsible-gambling disclaimer + ${RESPONSIBLE_GAMBLING_HELPLINE} helpline in the show notes.`);
  }
  if (prohibited.length > 0) {
    reasons.push(`Prohibited profit-promise language found: ${prohibited.map((p) => `"${p.match}"`).join(", ")}. Remove it before publishing.`);
  }
  return { betting: true, compliant: reasons.length === 0, reasons, prohibited, disclaimerPresent };
}
