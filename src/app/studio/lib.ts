// Shared helpers for the studio surface — pure functions over existing data.

export interface NextAction {
  label: string;
  href: string;
  stage: string;
}

/** Map an episode's pipeline status to the user's next move. */
export function nextActionFor(episode: { id: string; status: string }, scriptId?: string | null): NextAction {
  const s = episode.status;
  const sid = scriptId || "";
  switch (s) {
    case "draft":
      return { stage: "Script", label: "Write the script", href: "/admin/episodes" };
    case "script_draft":
      return { stage: "Script", label: "Review & approve the script", href: sid ? `/admin/scripts/${sid}` : "/admin/scripts" };
    case "script_approved":
      return { stage: "Fact check", label: "Run the fact check", href: "/admin/fact-checks" };
    case "fact_checked":
      return { stage: "Voices", label: "Generate the voices", href: sid ? `/admin/audio-segments/${sid}` : "/admin/audio-segments" };
    case "audio_segments_ready":
      return { stage: "Mix", label: "Stitch the episode", href: sid ? `/admin/final-audio/${sid}` : "/admin/final-audio" };
    case "audio_stitching":
      return { stage: "Mix", label: "Stitching now — watch progress", href: sid ? `/admin/final-audio/${sid}` : "/admin/final-audio" };
    case "audio_ready":
      return { stage: "Package", label: "Create show notes & assets", href: sid ? `/admin/content-assets/${sid}` : "/admin/content-assets" };
    case "content_ready":
      return { stage: "Package", label: "Prep publishing metadata", href: sid ? `/admin/content-assets/${sid}` : "/admin/content-assets" };
    case "publish_ready":
      return { stage: "Publish", label: "Publish to the feed", href: sid ? `/admin/rss/${sid}` : "/admin/rss" };
    case "published":
      return { stage: "Live", label: "View in feed", href: "/rss" };
    default:
      return { stage: "Pipeline", label: "Open pipeline", href: "/admin/episodes" };
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
