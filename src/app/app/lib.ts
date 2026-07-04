// Small helpers for the user surface — listener-friendly language.

export function fmtMin(seconds?: number | null): string {
  if (!seconds || seconds <= 0) return "—";
  return `${Math.max(1, Math.round(seconds / 60))} min`;
}

export function fmtClock(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtDay(d: Date | string): string {
  return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Friendly production-stage label for end users (no pipeline jargon). */
export function friendlyStage(status: string): { label: string; done: boolean } {
  switch (status) {
    case "draft": return { label: "Getting started", done: false };
    case "script_draft": return { label: "Writing the debate…", done: false };
    case "script_approved": return { label: "Script locked in", done: false };
    case "fact_checked": return { label: "Facts verified", done: false };
    case "audio_segments_ready": return { label: "Voices recorded", done: false };
    case "audio_stitching": return { label: "Mixing the episode…", done: false };
    case "audio_ready": return { label: "Ready to listen", done: true };
    case "content_ready": return { label: "Ready to listen", done: true };
    case "publish_ready": return { label: "Ready to publish", done: true };
    case "published": return { label: "Live", done: true };
    default: return { label: "In production", done: false };
  }
}

export const SPORT_EMOJI: Record<string, string> = {
  basketball: "🏀", football: "🏈", baseball: "⚾", soccer: "⚽", hockey: "🏒", "combat sports": "🥊",
};

export function emojiForTitle(title: string, sport?: string): string {
  const s = (sport || "").toLowerCase();
  if (SPORT_EMOJI[s]) return SPORT_EMOJI[s];
  const t = title.toLowerCase();
  if (/nba|basket|seed|dunk|court|lakers|luka|lebron/.test(t)) return "🏀";
  if (/nfl|draft|quarterback|football|trade/.test(t)) return "🏈";
  if (/messi|soccer|argentina|world cup|goal|marsch/.test(t)) return "⚽";
  if (/mlb|baseball|inning/.test(t)) return "⚾";
  if (/fight|ufc|knockout|octagon/.test(t)) return "🥊";
  return "“";
}
