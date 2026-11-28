"use server";

// Chemistry audition, in two paid steps the creator controls:
//   1. writeChemistryScene  — one model call writes a short in-character scene
//      from the selected hosts' stored profiles. The creator reads it first.
//   2. voiceChemistryScene  — performs it with the hosts' real voices: one
//      native multi-speaker scene when every host is on a scene-capable engine
//      (Fish), otherwise line by line on each host's own engine.
// Plus assignShowHosts, to put a pairing on a show. Nothing else is saved.

import { consumeRateLimit, rateLimitMessage, withInFlightLock } from "@/lib/rateLimit";
import { assertPremiumVoiceAllowed } from "@/lib/services/entitlementService";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { getRoleLLMProvider } from "@/lib/providers/llm/factory";
import { roleHasRealProvider } from "@/lib/providers/llm/routing";
import { categoryOf, describeFailure, isBillingCategory, isConfigurationCategory } from "@/lib/providers/llm/errors";
import { getTTSProvider } from "@/lib/providers/tts/factory";
import { isDialogueSceneProvider, type DialogueSceneInput } from "@/lib/providers/tts/sceneTypes";
import { providerSupportsSceneRendering } from "@/lib/providers/tts/capabilities";
import { isVoiceIdValidForProvider } from "@/lib/providers/tts/voiceResolution";
import { sanitizeForGenericTts } from "@/lib/providers/tts/sanitizer";
import { buildPerformanceDirection } from "@/lib/audio/performanceDirection";
import { resolveHostPerformanceProfile, PERFORMANCE_PROFILE_VERSION } from "@/lib/hosts/performanceProfile";
import { settingsFromHost } from "@/lib/hosts/hostStudioProfile";
import {
  AUDITION_JSON_SCHEMA, AUDITION_STYLES, auditionShapeProblem, buildAuditionPrompt, normalizeScene, sceneFacts, subjectText,
  type AuditionHost, type AuditionScene, type AuditionStyleId, type AuditionSubjectId, type SceneFacts,
} from "@/lib/talent/chemistryAudition";

const ROLE = "script_movement" as const; // the dialogue writer
const MAX_TOKENS = 2500;

type Fail = { success: false; error: string };
const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
const voiced = (provider: string, voiceId: string) => provider !== "stub" && !/^PLACEHOLDER[_-]/i.test(voiceId) && isVoiceIdValidForProvider(provider, voiceId);

async function loadHosts(userId: string, hostIds: string[]) {
  const ids = [...new Set(hostIds.filter(Boolean))];
  if (ids.length < 2 || ids.length > 3) return { error: "Choose two or three hosts." } as const;
  const rows = await db.aiHost.findMany({ where: { id: { in: ids }, isArchived: false, OR: [{ ownerId: userId }, { ownerId: null }] } });
  if (rows.length !== ids.length) return { error: "One of those hosts isn't available." } as const;
  return { rows: ids.map((id) => rows.find((r) => r.id === id)!) } as const;
}

export async function writeChemistryScene(input: { hostIds: string[]; subjectId: AuditionSubjectId; customSubject?: string; style: AuditionStyleId }): Promise<
  { success: true; scene: AuditionScene; facts: SceneFacts } | Fail
> {
  const user = await currentUser();
  if (!user) return { success: false, error: "Please sign in." };
  const run = await withInFlightLock(`audition-write:${user.id}`, 90_000, () => writeFor(user, input));
  return run.busy ? { success: false, error: "A scene is already being written. Wait for it to finish." } : run.value;
}

async function writeFor(user: { id: string }, input: Parameters<typeof writeChemistryScene>[0]): Promise<
  { success: true; scene: AuditionScene; facts: SceneFacts } | Fail
> {
  if (!AUDITION_STYLES.some((s) => s.id === input.style)) return { success: false, error: "Choose a conversation style." };
  const subject = subjectText(input.subjectId, input.customSubject ?? "");
  if (subject.length < 10) return { success: false, error: "Describe the subject in a sentence." };
  const loaded = await loadHosts(user.id, input.hostIds);
  if ("error" in loaded) return { success: false, error: loaded.error! };
  if (!roleHasRealProvider(ROLE)) return { success: false, error: "No AI writer is set up on this deployment, so a chemistry audition can't be written. Voice previews on each host still work." };

  const hosts: AuditionHost[] = loaded.rows.map((h) => ({
    id: h.id, name: h.name, role: h.role, worldview: h.worldview, speakingStyle: h.speakingStyle,
    catchphrases: arr(h.catchphrases), argumentPatterns: arr(h.argumentPatterns), likes: arr(h.likes), dislikes: arr(h.dislikes), bannedPhrases: arr(h.bannedPhrases),
    settings: settingsFromHost({ role: h.role, worldview: h.worldview, speakingStyle: h.speakingStyle, intensityLevel: h.intensityLevel, argumentPatterns: h.argumentPatterns, bannedPhrases: h.bannedPhrases, catchphrases: h.catchphrases, performanceProfile: h.performanceProfile }),
  }));
  const ids = hosts.map((h) => h.id);
  const gate = await consumeRateLimit("auditionWrite", user.id);
  if (!gate.allowed) return { success: false, error: rateLimitMessage("auditionWrite", gate.retryAfterSeconds) };
  const llm = getRoleLLMProvider(ROLE);
  try {
    const { systemPrompt, prompt } = buildAuditionPrompt(hosts, subject, input.style);
    const raw = await llm.generateStructuredOutput({
      systemPrompt, prompt,
      jsonSchema: AUDITION_JSON_SCHEMA as unknown as Record<string, any>,
      validate: (v) => auditionShapeProblem(v, ids),
      temperature: 0.9,
      maxTokens: MAX_TOKENS,
    });
    const scene = normalizeScene(raw, { hostIds: ids, subject, style: input.style, model: llm.name || null });
    if (auditionShapeProblem(scene, ids)) return { success: false, error: "The writer's scene didn't include every host enough times. Try again." };
    return { success: true, scene, facts: sceneFacts(scene) };
  } catch (err) {
    console.error("[chemistry] write failed:", describeFailure(err));
    const c = categoryOf(err);
    return {
      success: false,
      error: isBillingCategory(c) ? "The AI provider account is out of credit, so no scene was written."
        : isConfigurationCategory(c) ? "The AI provider isn't set up correctly on this deployment."
        : c === "structured_output_invalid_after_repair" ? "The writer's answer came back unreadable twice. Try again."
        : "The writer couldn't be reached just now. Try again in a moment.",
    };
  }
}

export type VoicedAudition =
  | { mode: "scene"; audioDataUrl: string; durationMs: number | null; engine: string }
  | { mode: "lines"; clips: { lineIndex: number; audioDataUrl: string; durationMs: number | null }[]; engine: string; failedLines: number[] };

/** `onlyLines`: re-voice just these lines (line-by-line mode), to recover a
 *  partial failure without paying for the lines that already worked. */
export async function voiceChemistryScene(scene: AuditionScene, onlyLines?: number[]): Promise<{ success: true; audio: VoicedAudition } | Fail> {
  const user = await currentUser();
  if (!user) return { success: false, error: "Please sign in." };
  const run = await withInFlightLock(`audition-voice:${user.id}`, 180_000, () => voiceFor(user, scene, onlyLines));
  return run.busy ? { success: false, error: "A scene is already being voiced. Wait for it to finish." } : run.value;
}

async function voiceFor(user: { id: string }, scene: AuditionScene, onlyLines?: number[]): Promise<{ success: true; audio: VoicedAudition } | Fail> {
  const loaded = await loadHosts(user.id, scene?.hostIds ?? []);
  if ("error" in loaded) return { success: false, error: loaded.error! };
  const ids = loaded.rows.map((h) => h.id);
  if (!Array.isArray(scene.lines) || auditionShapeProblem(scene, ids)) return { success: false, error: "That scene can't be voiced. Write it again." };
  // Re-normalise: the browser sent it, so it is input, not trusted output.
  const clean = normalizeScene(scene, { hostIds: ids, subject: scene.subject, style: scene.style, model: scene.model });
  const unvoiced = loaded.rows.filter((h) => !voiced(h.ttsProvider, h.ttsVoiceId));
  if (unvoiced.length) return { success: false, error: `${unvoiced.map((h) => h.name).join(" and ")} ${unvoiced.length === 1 ? "has" : "have"} no real voice yet. Create or attach one in their profile first.` };

  const engines = new Set(loaded.rows.map((h) => h.ttsProvider));
  // The same plan rule episode production uses: premium engines need a plan that includes them.
  for (const engine of engines) {
    const allowed = await assertPremiumVoiceAllowed(user.id, engine);
    if (!allowed.ok) return { success: false, error: allowed.error };
  }
  const gate = await consumeRateLimit("auditionVoice", user.id);
  if (!gate.allowed) return { success: false, error: rateLimitMessage("auditionVoice", gate.retryAfterSeconds) };
  const byId = new Map(loaded.rows.map((h) => [h.id, h]));
  const seat = new Map(ids.map((id, i) => [id, i]));
  const sceneEngine = engines.size === 1 ? [...engines][0] : null;
  const tts = sceneEngine ? getTTSProvider(sceneEngine) : null;

  // One performed scene: the engine hears the whole exchange, so turns, cut-ins and reactions connect.
  if (sceneEngine && tts && providerSupportsSceneRendering(sceneEngine) && isDialogueSceneProvider(tts)) {
    const input: DialogueSceneInput = {
      episodeId: "chemistry-audition", scriptId: "chemistry-audition", sceneId: "audition-0", sceneIndex: 0,
      sceneType: clean.style === "debate" ? "argument_escalation" : "conversation", formatId: "two_host_debate",
      utterances: clean.lines.map((l, i) => ({
        lineIndex: i, speakerHostId: l.speakerHostId, speakerName: byId.get(l.speakerHostId)!.name, seatIndex: seat.get(l.speakerHostId)!,
        voiceId: byId.get(l.speakerHostId)!.ttsVoiceId, spokenText: sanitizeForGenericTts(l.text),
        tone: l.tone, energy: l.energy, isInterruption: l.isInterruption, pauseBefore: l.pauseBefore, segmentBoundary: "none",
      })),
      cast: ids.map((id, i) => {
        const h = byId.get(id)!;
        const { profile } = resolveHostPerformanceProfile(h.performanceProfile, h);
        const roleId = i === 0 ? "chair_a" : "chair_b";
        return {
          speakerHostId: id, formatRoleId: roleId,
          direction: buildPerformanceDirection({ formatId: "two_host_debate", roleId, host: { name: h.name, speakingStyle: h.speakingStyle }, profile, sceneType: clean.style === "debate" ? "argument_escalation" : "conversation" }),
          intensityLevel: profile.peakIntensity, angerStyle: profile.angerStyle, maxCueDensity: profile.maxCueDensity, profileVersion: PERFORMANCE_PROFILE_VERSION,
          providerOverrides: (sceneEngine === "fish" ? profile.providerOverrides.fish : sceneEngine === "elevenlabs" ? profile.providerOverrides.elevenlabs : undefined) as Record<string, number> | undefined,
        };
      }),
      format: "mp3",
    };
    try {
      const res = await tts.synthesizeDialogueScene(input);
      if (!res.audioBuffer?.length) return { success: false, error: "The voice engine returned no audio. Try again." };
      return { success: true, audio: { mode: "scene", audioDataUrl: `data:${res.contentType || "audio/mpeg"};base64,${res.audioBuffer.toString("base64")}`, durationMs: res.durationMs ?? null, engine: `${sceneEngine} ${res.model}`.trim() } };
    } catch (err) {
      console.error("[chemistry] scene voicing failed:", (err as Error).message);
      return { success: false, error: `The voice engine couldn't perform the scene: ${(err as Error).message.slice(0, 160)}. Nothing was saved; try again.` };
    }
  }

  // Mixed engines: each line on its speaker's own voice, played back in order.
  const clips: { lineIndex: number; audioDataUrl: string; durationMs: number | null }[] = [];
  const failedLines: number[] = [];
  const wanted = Array.isArray(onlyLines) && onlyLines.length ? new Set(onlyLines.filter((n) => Number.isInteger(n))) : null;
  for (const [i, l] of clean.lines.entries()) {
    if (wanted && !wanted.has(i)) continue;
    const h = byId.get(l.speakerHostId)!;
    try {
      const r = await getTTSProvider(h.ttsProvider).synthesizeSpeech({
        text: sanitizeForGenericTts(l.text), voiceId: h.ttsVoiceId, speakerName: h.name, tone: l.tone, energy: l.energy, isInterruption: l.isInterruption,
        previousText: clean.lines[i - 1]?.text, nextText: clean.lines[i + 1]?.text, format: "mp3",
      });
      if (!r.audioBuffer?.length) throw new Error("empty audio");
      clips.push({ lineIndex: i, audioDataUrl: `data:${r.contentType || "audio/mpeg"};base64,${r.audioBuffer.toString("base64")}`, durationMs: r.durationMs ?? null });
    } catch { failedLines.push(i); }
  }
  if (!clips.length) return { success: false, error: "None of the lines could be voiced. Check each host's voice in their profile." };
  return { success: true, audio: { mode: "lines", clips, engine: [...engines].join(" + "), failedLines } };
}

/** Put a pairing on a show the creator owns. Production reads productionConfig.hostIds
 *  before podcast.hostIds, so both are written together (as setBusinessHosts does). */
export async function assignShowHosts(podcastId: string, hostIds: string[]): Promise<{ success: true } | Fail> {
  const user = await currentUser();
  if (!user) return { success: false, error: "Please sign in." };
  const pod = await db.podcast.findUnique({ where: { id: podcastId }, select: { id: true, ownerId: true } });
  if (!pod || (pod.ownerId !== user.id && user.role !== "ADMIN")) return { success: false, error: "That show isn't available." };
  const ids = [...new Set(hostIds.filter(Boolean))];
  // Episode generation supports one or two hosts today; a three-host audition can't be applied.
  if (ids.length < 1 || ids.length > 2) return { success: false, error: "A show can have one or two hosts. Audition a pair to apply it." };
  const found = await db.aiHost.findMany({ where: { id: { in: ids }, isActive: true, isArchived: false, OR: [{ ownerId: user.id }, { ownerId: null }] }, select: { id: true } });
  if (found.length !== ids.length) return { success: false, error: "One of those hosts isn't on air or isn't available." };
  await db.$transaction([
    db.podcast.update({ where: { id: podcastId }, data: { hostIds: ids } }),
    db.podcastProductionConfig.updateMany({ where: { podcastId }, data: { hostIds: ids } }),
  ]);
  revalidatePath("/studio/shows");
  revalidatePath(`/studio/shows/${podcastId}`);
  revalidatePath("/studio/hosts");
  return { success: true };
}

export async function listMyShows(): Promise<{ id: string; name: string; hostIds: string[] }[]> {
  const user = await currentUser();
  if (!user) return [];
  return db.podcast.findMany({ where: { ownerId: user.id }, select: { id: true, name: true, hostIds: true }, orderBy: { name: "asc" } });
}
