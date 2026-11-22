"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { canViewOwned } from "@/lib/ownerScope";
import { assertCanCreatePodcast } from "@/lib/services/entitlementService";
import { businessPodcastsEnabledFor } from "@/lib/business/intelligenceType";
import {
  AnswersSchema,
  BusinessEssentialsSchema,
  readFindings,
  type ProfileFinding,
} from "@/lib/business/profileSchema";
import { discoverBusiness } from "@/lib/business/discovery";
import { getRoleLLMProvider } from "@/lib/providers/llm/factory";

type Result<T = object> = ({ success: true } & T) | { success: false; error: string };

/** Load a business profile the current user may touch. Authority is the
 *  podcast's owner — never anything the client sends. */
async function ownedProfile(podcastId: string) {
  const user = await currentUser();
  if (!user) return { error: "Please sign in." } as const;
  const pod = await db.podcast.findUnique({
    where: { id: podcastId },
    select: { id: true, ownerId: true, intelligenceType: true, businessProfile: true },
  });
  if (!pod || !canViewOwned(user, pod)) return { error: "Show not found." } as const;
  if (pod.intelligenceType !== "BUSINESS" || !pod.businessProfile) return { error: "This isn't a business show." } as const;
  return { user, profile: pod.businessProfile } as const;
}

function revalidateShow(podcastId: string) {
  revalidatePath("/studio/shows");
  revalidatePath(`/studio/shows/${podcastId}`);
}

export async function createBusinessPodcast(raw: unknown): Promise<Result<{ podcastId: string }>> {
  try {
    const user = await currentUser();
    if (!user) return { success: false, error: "Please sign in to create a show." };
    if (!businessPodcastsEnabledFor(user)) return { success: false, error: "Business podcasts aren't enabled for this account yet." };
    const gate = await assertCanCreatePodcast(user.id);
    if (!gate.ok) return { success: false, error: gate.error };

    const parsed = BusinessEssentialsSchema.safeParse(raw);
    if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? "Check the form." };
    const e = parsed.data;

    const podcast = await db.$transaction(async (tx) => {
      const created = await tx.podcast.create({
        data: {
          name: e.showName,
          cadence: "one_time",
          // Server-decided. No client field reaches this column.
          intelligenceType: "BUSINESS",
          owner: user.email || "listener",
          ownerId: user.id,
          description: e.description ?? null,
          websiteUrl: e.websiteUrl ?? null,
          language: e.language,
        },
        select: { id: true },
      });
      // Same 1-1 config rows a sports show gets, so the canonical resolver
      // never reports a legacy fallback for a business show.
      await tx.podcastEditorialConfig.create({ data: { podcastId: created.id } });
      await tx.podcastProductionConfig.create({ data: { podcastId: created.id } });
      await tx.podcastPublishingConfig.create({ data: { podcastId: created.id } });
      await tx.businessProfile.create({
        data: {
          podcastId: created.id,
          businessName: e.businessName,
          websiteUrl: e.websiteUrl ?? null,
          description: e.description ?? null,
          industry: e.industry,
          subIndustries: e.subIndustries,
          targetAudiences: e.targetAudiences,
          primaryGoal: e.primaryGoal,
          geographicMarkets: e.geographicMarkets,
          language: e.language,
        },
      });
      return created;
    });

    revalidateShow(podcast.id);
    return { success: true, podcastId: podcast.id };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Could not create the show." };
  }
}

// ponytail: discovery runs inline in the server action (one fetch pass + one
// model call). Move to the research queue when Standard/Deep modes add
// multi-provider demand research — those won't fit a request lifetime.
export async function runBusinessDiscovery(podcastId: string): Promise<Result<{ added: number; skipped: string[] }>> {
  const owned = await ownedProfile(podcastId);
  if ("error" in owned) return { success: false, error: owned.error! };
  const p = owned.profile;

  // Atomic claim: one discovery at a time per profile.
  const claimed = await db.businessProfile.updateMany({
    where: { id: p.id, discoveryStatus: { not: "running" } },
    data: { discoveryStatus: "running", discoveryError: null },
  });
  if (claimed.count === 0) return { success: false, error: "Discovery is already running." };

  const res = await discoverBusiness(p, { llm: getRoleLLMProvider("evidence_extraction") }).catch(
    (err: Error) => ({ ok: false as const, error: err.message })
  );
  if (!res.ok) {
    await db.businessProfile.update({ where: { id: p.id }, data: { discoveryStatus: "failed", discoveryError: res.error.slice(0, 500) } });
    revalidateShow(podcastId);
    return { success: false, error: res.error };
  }

  // Re-running discovery replaces only PENDING suggestions. Anything the user
  // accepted, edited or rejected is their decision and survives.
  const kept = readFindings(p.findings).filter((f) => f.status !== "pending");
  const decided = new Set(kept.map((f) => `${f.field}|${f.value.toLowerCase()}`));
  const fresh = res.findings.filter((f) => !decided.has(`${f.field}|${f.value.toLowerCase()}`));
  await db.businessProfile.update({
    where: { id: p.id },
    data: {
      findings: [...kept, ...fresh] as unknown as Prisma.InputJsonValue,
      discoveryStatus: "complete",
      discoveredAt: new Date(),
      version: { increment: 1 },
    },
  });
  revalidateShow(podcastId);
  return { success: true, added: fresh.length, skipped: res.skipped };
}

export async function reviewFinding(
  podcastId: string,
  findingId: string,
  action: "accept" | "reject" | "edit",
  value?: string
): Promise<Result> {
  const owned = await ownedProfile(podcastId);
  if ("error" in owned) return { success: false, error: owned.error! };
  const p = owned.profile;
  const findings = readFindings(p.findings);
  const idx = findings.findIndex((f) => f.id === findingId);
  if (idx < 0) return { success: false, error: "That finding no longer exists." };

  const f = findings[idx];
  let next: ProfileFinding;
  if (action === "reject") next = { ...f, status: "rejected" };
  else if (action === "accept") {
    // Accepting an inference makes it the user's claim; a verified source stays verified.
    next = { ...f, status: "accepted", provenance: f.provenance === "SOURCE_VERIFIED" ? "SOURCE_VERIFIED" : "USER_CONFIRMED" };
  } else {
    const v = (value ?? "").trim();
    if (!v || v.length > 1000) return { success: false, error: "Edited value must be 1–1000 characters." };
    // An edit is the user's statement now — its old source quote no longer backs it.
    next = { ...f, value: v, status: "accepted", provenance: "USER_CONFIRMED", evidenceQuote: null, sourceUrl: null, confidence: 1 };
  }
  findings[idx] = next;

  // Compare-and-swap on version so two tabs can't silently overwrite each other.
  const res = await db.businessProfile.updateMany({
    where: { id: p.id, version: p.version },
    data: { findings: findings as unknown as Prisma.InputJsonValue, version: { increment: 1 } },
  });
  if (res.count === 0) return { success: false, error: "This profile changed in another window. Reload and try again." };
  revalidateShow(podcastId);
  return { success: true };
}

export async function saveBusinessAnswers(podcastId: string, raw: unknown, expectedVersion: number): Promise<Result> {
  const owned = await ownedProfile(podcastId);
  if ("error" in owned) return { success: false, error: owned.error! };
  const parsed = AnswersSchema.safeParse(raw);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid answers." };
  // Drop blanks so "skipped" and "answered" stay distinguishable.
  const fields = Object.fromEntries(Object.entries(parsed.data.fields).filter(([, v]) => v.trim()));
  const res = await db.businessProfile.updateMany({
    where: { id: owned.profile.id, version: expectedVersion },
    data: { answers: { ...parsed.data, fields } as unknown as Prisma.InputJsonValue, version: { increment: 1 } },
  });
  if (res.count === 0) return { success: false, error: "This profile changed in another window. Reload and try again." };
  revalidateShow(podcastId);
  return { success: true };
}
