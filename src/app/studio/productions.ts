// What is being made right now, and what is waiting on the viewer.
//
// ONE read, used by Studio Home and by the activity menu in the shell, so the
// two can never disagree about whether an episode is running, stuck or yours
// to act on.
//
// It invents nothing. Every state here is `getCreateProgressBatch` — the same
// authoritative read the episode's own production console renders — so a
// failure comes from the stage's JobLog, "needs you" comes from the real
// approval and release gates, and a percentage exists only for voicing, which
// is the only stage with a real denominator.

import "server-only";
import { db } from "@/lib/db";
import { ownerScope, type ScopeViewer } from "@/lib/ownerScope";
import { getCreateProgressBatch } from "@/lib/services/createProgress";
import { FINISHED_STATUSES, bustAudioUrl, nextActionFor } from "./lib";

/** `unknown`: the progress read failed. Never shown or counted as running. */
export type ProductionState = "failed" | "needs_you" | "stalled" | "running" | "ready" | "unknown";

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
  /** One page of in-flight episodes (newest first) plus one page of finished ones. */
  items: ProductionItem[];
  /** Exact counts over ALL of the viewer's unpublished episodes, not just this page. */
  totals: { inFlight: number; ready: number };
  /** In-flight episodes after this page. Their state has NOT been read. */
  more: number;
  /** Pass to the next call to read the following page of in-flight episodes. */
  nextOffset: number | null;
}

/** In-flight episodes read per call. Progress for a page costs a fixed six
 *  queries (getCreateProgressBatch), so this bounds payload, not query count. */
export const PRODUCTIONS_PAGE = 24;

const ORDER: Record<ProductionState, number> = { failed: 0, needs_you: 1, stalled: 2, unknown: 3, ready: 4, running: 5 };
const READY_STATUSES = FINISHED_STATUSES.filter((s) => s !== "published");

export async function getStudioProductions(
  viewer: ScopeViewer | null,
  opts: { offset?: number } = {}
): Promise<StudioProductions> {
  if (!viewer) return { items: [], totals: { inFlight: 0, ready: 0 }, more: 0, nextOffset: null };
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));

  // "Ready" = finished audio, not yet published. Everything else unpublished is in flight.
  const isReady = { status: { in: READY_STATUSES }, audioUrl: { not: null } };
  const scope = ownerScope(viewer);
  const readyWhere = { AND: [scope, isReady] };
  const inFlightWhere = { AND: [scope, { status: { not: "published" } }, { NOT: isReady }] };
  const select = {
    id: true,
    title: true,
    status: true,
    audioUrl: true,
    updatedAt: true,
    podcast: { select: { id: true, name: true } },
  } as const;

  const [inFlight, inFlightTotal, finished, readyTotal] = await Promise.all([
    db.episode.findMany({ where: inFlightWhere, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], skip: offset, take: PRODUCTIONS_PAGE, select }),
    db.episode.count({ where: inFlightWhere }),
    // Finished episodes only on the first page; later pages are "more in flight".
    offset === 0 ? db.episode.findMany({ where: readyWhere, orderBy: { updatedAt: "desc" }, take: PRODUCTIONS_PAGE, select }) : [],
    db.episode.count({ where: readyWhere }),
  ]);

  const base = (ep: (typeof inFlight)[number]) => ({
    episodeId: ep.id,
    title: ep.title,
    showId: ep.podcast?.id ?? null,
    showName: ep.podcast?.name ?? null,
    audioUrl: null as string | null,
    updatedAtIso: ep.updatedAt.toISOString(),
  });

  // One batched read for the whole page. If it throws, every row is "unknown":
  // a failed read is not evidence that anything is running.
  const vms = await getCreateProgressBatch(inFlight.map((e) => e.id)).catch(() => null);

  const running = inFlight.map((ep): ProductionItem => {
    const next = nextActionFor(ep);
    const href = `/studio/episodes/${ep.id}`;
    const vm = vms?.get(ep.id);
    if (!vm || !vm.ok) {
      return { ...base(ep), state: "unknown", stage: next.stage, headline: "Its progress could not be read just now. Open it to check.", href, progress: null };
    }
    const active = vm.stages.find((s) => s.state === "active" || s.state === "checkpoint" || s.state === "failed");
    const counted = active?.progress && active.progress.total ? { done: active.progress.done, total: active.progress.total } : null;
    if (vm.failure) return { ...base(ep), state: "failed", stage: vm.failure.label, headline: vm.failure.message, href, progress: null };
    if (vm.awaitingUser) return { ...base(ep), state: "needs_you", stage: next.stage, headline: vm.headline, href: next.href, progress: null };
    if (vm.stalled) return { ...base(ep), state: "stalled", stage: active?.label ?? next.stage, headline: "Nothing has moved for a while. Open it to retry.", href, progress: null };
    return { ...base(ep), state: "running", stage: active?.label ?? next.stage, headline: vm.headline, href, progress: counted };
  });

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
  const more = Math.max(0, inFlightTotal - offset - inFlight.length);
  return { items, totals: { inFlight: inFlightTotal, ready: readyTotal }, more, nextOffset: more > 0 ? offset + inFlight.length : null };
}
