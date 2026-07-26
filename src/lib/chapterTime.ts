// Chapter / duration stamps for published show notes and RSS.
//
// Extracted from contentAssetService so it can be tested against real values
// rather than a copy. The bug this replaces shipped to the live feed:
//
//   "1:13.599999999999994 — Intro"
//   "12:6.7000000000000455 — Closing"
//
// Two faults in one line. `sec` arrives fractional (startTimeMs / 100 / 10), so
// `sec % 60` kept the float noise; and `.padStart(2, "0")` cannot pad a string
// that is already longer than two characters, so the seconds were never padded
// either. Podcast chapters are whole seconds by convention — round first.

/** "0:31", "12:07", "1:01:01". Always whole seconds, always zero-padded. */
export function formatChapterTime(sec: number): string {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}
