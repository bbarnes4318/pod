"use server";

// User-surface podcast actions. Deliberately NOT admin-gated: /app is the
// listener surface (it has no auth layer), while requireAdmin() guards the
// /admin operator console. Validation is strict server-side so the wizard
// can never persist a malformed podcast.

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/currentUser";
import {
  isValidVertical,
  normalizeVerticals,
  teamLeagueIdsForVerticals,
} from "@/lib/verticals";
import { WEEKDAYS, SEGMENT_MIN, SEGMENT_MAX, type PodcastInput } from "./config";
import { enqueueEpisodeBuildForPodcast } from "@/lib/services/recurringPodcastService";

interface Validated {
  name: string;
  cadence: "one_time" | "recurring";
  scheduleDays: string[];
  verticals: string[];
  teams: string[];
  segmentCount: number;
  hostIds: string[];
}

async function validatePodcastInput(input: PodcastInput, userId?: string): Promise<{ ok: true; data: Validated } | { ok: false; error: string }> {
  const name = (input.name || "").trim();
  if (!name) return { ok: false, error: "Give your podcast a name." };
  if (name.length > 80) return { ok: false, error: "Keep the name under 80 characters." };

  if (input.cadence !== "one_time" && input.cadence !== "recurring") {
    return { ok: false, error: "Pick one-time or recurring." };
  }

  let scheduleDays: string[] = [];
  if (input.cadence === "recurring") {
    scheduleDays = [...new Set((input.scheduleDays || []).map((d) => d.toLowerCase()))].filter((d) =>
      (WEEKDAYS as readonly string[]).includes(d)
    );
    if (scheduleDays.length === 0) {
      return { ok: false, error: "A recurring podcast needs at least one weekday." };
    }
    // keep stored order canonical (mon..sun)
    scheduleDays.sort((a, b) => WEEKDAYS.indexOf(a as any) - WEEKDAYS.indexOf(b as any));
  }

  const rawVerticals = (input.verticals || []).filter(isValidVertical);
  if (rawVerticals.length === 0) return { ok: false, error: "Pick at least one vertical." };
  const verticals = normalizeVerticals(rawVerticals);

  // Teams are optional (a vertical-wide podcast is valid) but every id must
  // exist and belong to a league implied by the chosen verticals.
  const teams = [...new Set(input.teams || [])];
  if (teams.length > 0) {
    const allowedLeagues = teamLeagueIdsForVerticals(verticals);
    const found = await db.team.findMany({
      where: { id: { in: teams } },
      select: { id: true, leagueId: true },
    });
    if (found.length !== teams.length) return { ok: false, error: "One of the selected teams no longer exists." };
    const outOfScope = found.filter((t) => !allowedLeagues.includes(t.leagueId));
    if (outOfScope.length > 0) {
      return { ok: false, error: "A selected team doesn't match the chosen verticals." };
    }
  }

  const segmentCount = Math.round(Number(input.segmentCount));
  if (!Number.isFinite(segmentCount) || segmentCount < SEGMENT_MIN || segmentCount > SEGMENT_MAX) {
    return { ok: false, error: `Segments must be between ${SEGMENT_MIN} and ${SEGMENT_MAX}.` };
  }

  const hostIds = [...new Set(input.hostIds || [])];
  if (hostIds.length === 0) return { ok: false, error: "Pick at least one host." };
  // Only the caller's own hosts + shared (null-owner) starters may be cast —
  // server-enforced so a crafted request can't pin another account's host.
  const hosts = await db.aiHost.findMany({
    where: {
      id: { in: hostIds },
      isActive: true,
      ...(userId ? { OR: [{ ownerId: userId }, { ownerId: null }] } : { ownerId: null }),
    },
    select: { id: true },
  });
  if (hosts.length !== hostIds.length) return { ok: false, error: "One of the selected hosts is unavailable." };

  return { ok: true, data: { name, cadence: input.cadence, scheduleDays, verticals, teams, segmentCount, hostIds } };
}

export async function createPodcast(input: PodcastInput) {
  try {
    const user = await currentUser();
    if (!user) return { success: false as const, error: "Please sign in to create a podcast." };
    const v = await validatePodcastInput(input, user.id);
    if (!v.ok) return { success: false as const, error: v.error };

    const podcast = await db.podcast.create({
      data: { ...v.data, owner: user.email || "listener", ownerId: user.id },
    });

    revalidatePath("/app/podcasts");
    return { success: true as const, podcastId: podcast.id };
  } catch (err: any) {
    return { success: false as const, error: err.message || "Could not create the podcast." };
  }
}

/**
 * On-demand generation: enqueue one episode build from the podcast's CURRENT
 * saved config, any time, regardless of cadence/schedule. Unlike the daily
 * scheduler this is intentionally not once-per-day-idempotent — pressing the
 * button twice queues two builds; the timestamped jobId only guards against
 * accidental double-submits within the same second.
 */
export async function generateEpisodesNow(podcastId: string) {
  try {
    const user = await currentUser();
    if (!user) return { success: false as const, error: "Please sign in to generate episodes." };
    const podcast = await db.podcast.findUnique({ where: { id: podcastId } });
    if (!podcast) return { success: false as const, error: "Podcast not found." };
    // Owner-only (legacy null-owner podcasts remain manageable for continuity).
    if (podcast.ownerId && podcast.ownerId !== user.id) {
      return { success: false as const, error: "This podcast belongs to another account." };
    }

    const stamp = new Date().toISOString();
    const job = await enqueueEpisodeBuildForPodcast(podcast, {
      titleSuffix: stamp.slice(0, 10),
      jobId: `manual-${podcastId}-${stamp.slice(0, 19)}`,
    });

    revalidatePath("/app/podcasts");
    revalidatePath(`/app/podcasts/${podcastId}`);
    return { success: true as const, jobId: String(job.id) };
  } catch (err: any) {
    return { success: false as const, error: err.message || "Could not queue the episode." };
  }
}

export async function updatePodcast(id: string, input: PodcastInput) {
  try {
    const user = await currentUser();
    if (!user) return { success: false as const, error: "Please sign in to edit a podcast." };
    const existing = await db.podcast.findUnique({ where: { id }, select: { id: true, ownerId: true } });
    if (!existing) return { success: false as const, error: "Podcast not found." };
    // Owner-only (legacy null-owner podcasts remain editable for continuity).
    if (existing.ownerId && existing.ownerId !== user.id) {
      return { success: false as const, error: "This podcast belongs to another account." };
    }

    const v = await validatePodcastInput(input, user.id);
    if (!v.ok) return { success: false as const, error: v.error };

    await db.podcast.update({ where: { id }, data: v.data });

    revalidatePath("/app/podcasts");
    revalidatePath(`/app/podcasts/${id}`);
    return { success: true as const, podcastId: id };
  } catch (err: any) {
    return { success: false as const, error: err.message || "Could not save your changes." };
  }
}
