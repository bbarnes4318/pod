// Shared helpers for the studio surface — pure functions over existing data.

export interface NextAction {
  label: string;
  href: string;
  stage: string;
}

/**
 * Map an episode's pipeline status to the user's next move.
 *
 * Every destination stays inside /studio. These labels are shown to customers,
 * and the /admin console is operator-only and Basic-Auth locked — the previous
 * version pointed a customer at /admin/scripts, /admin/final-audio, and friends
 * ("Stitching now — watch progress" sent them to the ops console), which is a
 * dead end for anyone who isn't an operator. In-studio equivalents now exist:
 * the production console covers progress, and the episode tabs are addressable
 * by hash (see EpisodeWorkspace).
 *
 * Ops shortcuts are still reachable — the episode page keeps them behind an
 * explicit "Advanced / ops shortcuts" disclosure.
 */
export function nextActionFor(episode: { id: string; status: string }): NextAction {
  const ep = `/studio/episodes/${episode.id}`;
  switch (episode.status) {
    case "draft":
      return { stage: "Script", label: "Watch it being written", href: ep };
    case "script_draft":
      return { stage: "Script", label: "Read & approve the script", href: `${ep}#transcript` };
    case "script_approved":
      return { stage: "Fact check", label: "Check the claims", href: `${ep}#transcript` };
    case "fact_checked":
      return { stage: "Voices", label: "Record the voices", href: `${ep}#produce` };
    case "audio_segments_ready":
      return { stage: "Mix", label: "Mix the episode", href: `${ep}#produce` };
    case "audio_stitching":
      return { stage: "Mix", label: "Mixing now — watch progress", href: ep };
    case "audio_ready":
      return { stage: "Package", label: "Create show notes & assets", href: `${ep}#publish` };
    case "content_ready":
      return { stage: "Package", label: "Prep publishing metadata", href: `${ep}#publish` };
    case "publish_ready":
      return { stage: "Publish", label: "Publish to the feed", href: `${ep}#publish` };
    case "published":
      return { stage: "Live", label: "View in feed", href: "/rss" };
    default:
      return { stage: "Pipeline", label: "Open episode", href: ep };
  }
}

/** Pull the 0-100 quality report out of a script's content JSON (if present). */
export function qualityOf(script: { content: unknown } | null | undefined): {
  total: number;
  axes: Record<string, { score: number; max: number; detail?: string }>;
} | null {
  const q = (script?.content as any)?.quality;
  if (!q || typeof q.total !== "number" || !q.axes) return null;
  return q;
}

export function fmtDuration(seconds?: number | null): string {
  if (!seconds || seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtDate(d: Date | string): string {
  return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const FINISHED_STATUSES = ["audio_ready", "content_ready", "publish_ready", "published"];

export function statusChip(status: string): { label: string; kind: "accent" | "success" | "plain" } {
  switch (status) {
    case "published":
      return { label: "Live", kind: "success" };
    case "publish_ready":
      return { label: "Ready to publish", kind: "accent" };
    case "audio_ready":
    case "content_ready":
      return { label: "Audio ready", kind: "accent" };
    case "audio_stitching":
      return { label: "Mixing…", kind: "accent" };
    case "audio_segments_ready":
      return { label: "Voices done", kind: "plain" };
    case "fact_checked":
      return { label: "Fact-checked", kind: "plain" };
    case "script_approved":
      return { label: "Script approved", kind: "plain" };
    case "script_draft":
      return { label: "Script drafted", kind: "plain" };
    default:
      return { label: status.replace(/_/g, " "), kind: "plain" };
  }
}
