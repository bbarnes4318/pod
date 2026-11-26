// What is being made right now, and what is waiting on the viewer.
//
// ONE read, used by Studio Home and by the activity menu in the shell, so the
// two can never disagree about whether an episode is running, stuck or yours
// to act on.
//
// It invents nothing. Every state here is `getCreateProgressVM` — the same
// authoritative read the episode's own production console renders — so a
// failure comes from the stage's JobLog, "needs you" comes from the real
// approval and release gates, and a percentage exists only for voicing, which
// is the only stage with a real denominator.

import "server-only";
import { db } from "@/lib/db";
import { ownerScope, type ScopeViewer } from "@/lib/ownerScope";
import { getCreateProgressVM } from "@/lib/services/createProgress";
import { FINISHED_STATUSES, bustAudioUrl, nextActionFor } from "./lib";

export type ProductionState = "failed" | "needs_you" | "stalled" | "running" | "ready";

export interface ProductionItem {
  episodeId: string;
  title: string;
  showId: string | null;
  showName: string | null;
  state: ProductionState;
  /** One plain sentence: what is happening, or what is being asked. */
  headline: string;
  /** Stage label, e.g. "Voices". */
  stage: string;
  /** Lands on the place the work is done, not just on the episode. */
  href: string;
  /** Real counted voicing progress, when the active stage has one. */
  progress: { done: number; total: number } | null;
  /** Finished audio, cache-busted the same way the episode page does. Only on `ready`. */
  audioUrl: string | null;
  updatedAtIso: string;
}

export interface StudioProductions {
  items: ProductionItem[];
  /** In-flight episodes beyond the ones read in detail. */
  more: number;
}

// ponytail: each in-flight episode costs one full progress read (~10 queries).
// Capped so Home stays fast; a creator with more than this many episodes
// mid-production sees the rest counted in `more`. Batch the JobLog reads if
// that ceiling starts to matter.
const DETAIL_CAP = 8;

const ORDER: Record<ProductionState, number> = { failed: 0, needs_you: 1, stalled: 2, ready: 3, running: 4 };

export async function getStudioProductions(viewer: ScopeViewer | null): Promise<StudioProductions> {
  if (!viewer) return { items: [], more: 0 };

  const episodes = await db.episode.findMany({
    where: { ...ownerScope(viewer), status: { not: "published" } },
    orderBy: { updatedAt: "desc" },
    take: 40,
    select: {
      id: true,
      title: true,
      status: true,
      audioUrl: true,
      updatedAt: true,
      podcast: { select: { id: true, name: true } },
    },
  });

  const finished = episodes.filter((ep) => FINISHED_STATUSES.includes(ep.status) && !!ep.audioUrl);
  const finishedIds = new Set(finished.map((ep) => ep.id));
  const inFlight = episodes.filter((ep) => !finishedIds.has(ep.id));
  const detailed = inFlight.slice(0, DETAIL_CAP);

  const base = (ep: (typeof episodes)[number]) => ({
    episodeId: ep.id,
    title: ep.title,
    showId: ep.podcast?.id ?? null,
    showName: ep.podcast?.name ?? null,
    audioUrl: null as string | null,
    updatedAtIso: ep.updatedAt.toISOString(),
  });

  const running = await Promise.all(
    detailed.map(async (ep): Promise<ProductionItem> => {
      const next = nextActionFor(ep);
      try {
        const vm = await getCreateProgressVM(ep.id);
        const active = vm.stages.find((s) => s.state === "active" || s.state === "checkpoint" || s.state === "failed");
        const counted = active?.progress && active.progress.total ? { done: active.progress.done, total: active.progress.total } : null;
        if (vm.failure) {
          return { ...base(ep), state: "failed", stage: vm.failure.label, headline: vm.failure.message, href: `/studio/episodes/${ep.id}`, progress: null };
        }
        if (vm.awaitingUser) {
          return { ...base(ep), state: "needs_you", stage: next.stage, headline: vm.headline, href: next.href, progress: null };
        }
        if (vm.stalled) {
          return { ...base(ep), state: "stalled", stage: active?.label ?? next.stage, headline: "Nothing has moved for a while. Open it to retry.", href: `/studio/episodes/${ep.id}`, progress: null };
        }
        return { ...base(ep), state: "running", stage: active?.label ?? next.stage, headline: vm.headline, href: `/studio/episodes/${ep.id}`, progress: counted };
      } catch {
        // The detailed read failed; say only what the row itself proves.
        return { ...base(ep), state: "running", stage: next.stage, headline: next.label, href: next.href, progress: null };
      }
    })
  );

  const ready: ProductionItem[] = finished.map((ep) => ({
    ...base(ep),
    state: "ready",
    stage: "Release",
    headline: ep.status === "publish_ready" ? "Ready to publish" : "Audio is finished. Review it, then release.",
    href: `/studio/episodes/${ep.id}#publish`,
    progress: null,
    audioUrl: bustAudioUrl(ep.audioUrl!, ep.updatedAt),
  }));

  const items = [...running, ...ready].sort(
    (a, b) => ORDER[a.state] - ORDER[b.state] || b.updatedAtIso.localeCompare(a.updatedAtIso)
  );
  return { items, more: Math.max(0, inFlight.length - detailed.length) };
}
