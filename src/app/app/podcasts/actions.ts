"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/currentUser";
import { canViewOwned } from "@/lib/ownerScope";
import { assertCanCreatePodcast } from "@/lib/services/entitlementService";
import {
  isValidVertical,
  normalizeVerticals,
  teamLeagueIdsForVerticals,
} from "@/lib/verticals";
import { encodeShowForgeState, showForgeStateSchema, type ShowForgeState } from "@/lib/shows/showForge";
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
  showForge: ShowForgeState;
}

async function validatePodcastInput(input: PodcastInput, userId?: string): Promise<{ ok: true; data: Validated } | { ok: false; error: string }> {
  const name = (input.name || "").trim();
  if (!name) return { ok: false, error: "Give your show a name." };
  if (name.length > 80) return { ok: false, error: "Keep the show name under 80 characters." };

  if (input.cadence !== "one_time" && input.cadence !== "recurring") {
    return { ok: false, error: "Pick one-time or recurring." };
  }

  let scheduleDays: string[] = [];
  if (input.cadence === "recurring") {
    scheduleDays = [...new Set((input.scheduleDays || []).map((day) => day.toLowerCase()))]
      .filter((day) => (WEEKDAYS as readonly string[]).includes(day));
    if (scheduleDays.length === 0) return { ok: false, error: "A recurring show needs at least one weekday." };
    scheduleDays.sort((a, b) => WEEKDAYS.indexOf(a as never) - WEEKDAYS.indexOf(b as never));
  }

  const rawVerticals = (input.verticals || []).filter(isValidVertical);
  if (rawVerticals.length === 0) return { ok: false, error: "Pick at least one sports world for the show." };
  const verticals = normalizeVerticals(rawVerticals);

  const teams = [...new Set(input.teams || [])];
  if (teams.length > 0) {
    const allowedLeagues = teamLeagueIdsForVerticals(verticals);
    const found = await db.team.findMany({
      where: { id: { in: teams } },
      select: { id: true, leagueId: true },
    });
    if (found.length !== teams.length) return { ok: false, error: "One selected team no longer exists." };
    if (found.some((team) => !allowedLeagues.includes(team.leagueId))) {
      return { ok: false, error: "A selected team does not match the chosen sports worlds." };
    }
  }

  const segmentCount = Math.round(Number(input.segmentCount));
  if (!Number.isFinite(segmentCount) || segmentCount < SEGMENT_MIN || segmentCount > SEGMENT_MAX) {
    return { ok: false, error: `Episode topics must be between ${SEGMENT_MIN} and ${SEGMENT_MAX}.` };
  }

  const hostIds = [...new Set(input.hostIds || [])];
  if (hostIds.length < 1 || hostIds.length > 2) return { ok: false, error: "Choose one or two hosts." };
  const hosts = await db.aiHost.findMany({
    where: {
      id: { in: hostIds },
      isActive: true,
      isArchived: false,
      ...(userId ? { OR: [{ ownerId: userId }, { ownerId: null }] } : { ownerId: null }),
    },
    select: { id: true },
  });
  if (hosts.length !== hostIds.length) return { ok: false, error: "One selected host is unavailable." };

  const parsedShow = showForgeStateSchema.safeParse(input.showForge);
  if (!parsedShow.success) {
    const issue = parsedShow.error.issues[0];
    return { ok: false, error: `Show design: ${issue?.message || "one of the creative settings is invalid."}` };
  }
  const storylineIds = parsedShow.data.storylines.map((storyline) => storyline.id);
  if (new Set(storylineIds).size !== storylineIds.length) return { ok: false, error: "Each storyline needs a unique name." };
  for (const storyline of parsedShow.data.storylines) {
    if (storyline.featuredHostIds.some((id) => !hostIds.includes(id))) {
      return { ok: false, error: `The storyline “${storyline.title}” features a host who is not in this show.` };
    }
  }

  return {
    ok: true,
    data: { name, cadence: input.cadence, scheduleDays, verticals, teams, segmentCount, hostIds, showForge: parsedShow.data },
  };
}

function canonicalRows(v: Validated) {
  return {
    podcast: {
      name: v.name,
      cadence: v.cadence,
      scheduleDays: v.scheduleDays,
      verticals: v.verticals,
      teams: v.teams,
      segmentCount: v.segmentCount,
      hostIds: v.hostIds,
      description: v.showForge.bible.premise,
    },
    editorial: {
      verticals: v.verticals,
      teams: v.teams,
      segmentCount: v.segmentCount,
      format: "two_host_debate",
      scriptStyle: encodeShowForgeState(v.showForge),
      maxWords: null,
      minDebateScore: null,
    },
    production: {
      hostIds: v.hostIds,
      productionStyle: "full",
      sfxDensity: "subtle",
    },
  };
}

function revalidateShowRoutes(podcastId?: string) {
  revalidatePath("/studio/shows");
  revalidatePath("/studio/create");
  if (podcastId) revalidatePath(`/studio/shows/${podcastId}`);

  // Keep legacy redirect routes warm during the transition.
  revalidatePath("/app/podcasts");
  if (podcastId) revalidatePath(`/app/podcasts/${podcastId}`);
}

export async function createPodcast(input: PodcastInput) {
  try {
    const user = await currentUser();
    if (!user) return { success: false as const, error: "Please sign in to create a show." };
    const gate = await assertCanCreatePodcast(user.id);
    if (!gate.ok) return { success: false as const, error: gate.error, upgrade: true as const };
    const validated = await validatePodcastInput(input, user.id);
    if (!validated.ok) return { success: false as const, error: validated.error };
    const rows = canonicalRows(validated.data);

    const podcast = await db.$transaction(async (tx) => {
      const created = await tx.podcast.create({
        data: { ...rows.podcast, owner: user.email || "listener", ownerId: user.id },
        select: { id: true },
      });
      await tx.podcastEditorialConfig.create({ data: { podcastId: created.id, ...rows.editorial } });
      await tx.podcastProductionConfig.create({ data: { podcastId: created.id, ...rows.production } });
      await tx.podcastPublishingConfig.create({ data: { podcastId: created.id } });
      await tx.showContinuity.create({ data: { podcastId: created.id } });
      return created;
    });

    revalidateShowRoutes(podcast.id);
    return { success: true as const, podcastId: podcast.id };
  } catch (error) {
    return { success: false as const, error: error instanceof Error ? error.message : "Could not create the show." };
  }
}

export async function generateEpisodesNow(podcastId: string) {
  try {
    const user = await currentUser();
    if (!user) return { success: false as const, error: "Please sign in to generate episodes." };
    const podcast = await db.podcast.findUnique({ where: { id: podcastId } });
    if (!podcast) return { success: false as const, error: "Show not found." };
    if (!canViewOwned(user, podcast)) return { success: false as const, error: "This show belongs to another account." };

    const stamp = new Date().toISOString();
    const job = await enqueueEpisodeBuildForPodcast(podcast, {
      titleSuffix: stamp.slice(0, 10),
      jobId: `manual-${podcastId}-${stamp.slice(0, 19)}`,
    });

    revalidateShowRoutes(podcastId);
    revalidatePath("/studio/episodes");
    revalidatePath("/app/episodes");
    return { success: true as const, jobId: String(job.id) };
  } catch (error) {
    return { success: false as const, error: error instanceof Error ? error.message : "Could not queue the episode." };
  }
}

export async function updatePodcast(id: string, input: PodcastInput) {
  try {
    const user = await currentUser();
    if (!user) return { success: false as const, error: "Please sign in to edit a show." };
    const existing = await db.podcast.findUnique({ where: { id }, select: { id: true, ownerId: true } });
    if (!existing) return { success: false as const, error: "Show not found." };
    if (!canViewOwned(user, existing)) return { success: false as const, error: "This show belongs to another account." };

    const validated = await validatePodcastInput(input, user.id);
    if (!validated.ok) return { success: false as const, error: validated.error };
    const rows = canonicalRows(validated.data);

    await db.$transaction(async (tx) => {
      await tx.podcast.update({
        where: { id },
        data: { ...rows.podcast, configVersion: { increment: 1 } },
      });
      await tx.podcastEditorialConfig.upsert({
        where: { podcastId: id },
        create: { podcastId: id, ...rows.editorial },
        update: rows.editorial,
      });
      await tx.podcastProductionConfig.upsert({
        where: { podcastId: id },
        create: { podcastId: id, ...rows.production },
        update: rows.production,
      });
      await tx.podcastPublishingConfig.upsert({ where: { podcastId: id }, create: { podcastId: id }, update: {} });
      await tx.showContinuity.upsert({ where: { podcastId: id }, create: { podcastId: id }, update: {} });
    });

    revalidateShowRoutes(id);
    return { success: true as const, podcastId: id };
  } catch (error) {
    return { success: false as const, error: error instanceof Error ? error.message : "Could not save the show." };
  }
}
