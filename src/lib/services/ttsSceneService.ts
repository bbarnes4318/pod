// Scene-mode spoken-audio generation.
//
// Replaces one-request-per-line with one request per SCENE for engines whose
// verified capabilities support native multi-speaker dialogue (ElevenLabs
// Text to Dialogue, Fish S2-Pro). The approved script is the source of truth:
// text is never rewritten, only sanitized of markdown; provider control
// syntax exists ONLY inside the adapters and safe metadata.
//
// Rollout contract (Prompt 16):
//   TTS_RENDER_MODE = legacy_line (default) | scene | auto
//   TTS_SCENE_PROVIDER_ALLOWLIST = elevenlabs,fish (default)
//   TTS_SCENE_CANDIDATES_COLD_OPEN / _PEAK / _DEFAULT
//   ELEVENLABS_DIALOGUE_TIMESTAMPS = true (default) | false
// The decision that was actually taken is PERSISTED on Episode.ttsRenderMode
// ("scene" | "mixed_fallback" | "legacy_line") — never re-inferred from env.

import crypto from "crypto";
import { db } from "@/lib/db";
import { getStorageProvider } from "@/lib/providers/storage/factory";
import { getTTSProvider } from "@/lib/providers/tts/factory";
import { sanitizeForGenericTts } from "@/lib/providers/tts/sanitizer";
import { getTtsModelId, resolveTtsProviderAndVoice, type ResolvedTtsVoice, type TtsVoiceOverrides } from "@/lib/providers/tts/voiceResolution";
import { getTtsProviderCapabilities, providerSupportsSceneRendering } from "@/lib/providers/tts/capabilities";
import {
  isDialogueSceneProvider,
  SceneGenerationError,
  type DialogueSceneInput,
  type DialogueSceneType,
  type SceneErrorCategory,
  type ScenePerformanceContext,
  type SceneUtterance,
} from "@/lib/providers/tts/sceneTypes";
import {
  planDialogueScenes,
  plannerLinesFromScriptSegments,
  resolveSceneForLine,
  sceneRequestFingerprint,
  SCENE_PLANNER_VERSION,
  type PlannedScene,
  type ScenePlan,
} from "@/lib/audio/dialogueScenePlanner";
import { buildPerformanceDirection } from "@/lib/audio/performanceDirection";
import { resolveHostPerformanceProfile, PERFORMANCE_PROFILE_VERSION } from "@/lib/hosts/performanceProfile";
import { resolveEpisodeCast } from "@/lib/services/hostCasting";
import { generateTtsSegments } from "@/lib/services/ttsSegmentService";

export type TtsRenderModeSetting = "legacy_line" | "scene" | "auto";
export type PersistedRenderMode = "legacy_line" | "scene" | "mixed_fallback" | "performance_conversion";

export function readRenderModeSetting(env: NodeJS.ProcessEnv = process.env): TtsRenderModeSetting {
  const v = (env.TTS_RENDER_MODE || "legacy_line").trim().toLowerCase();
  return v === "scene" || v === "auto" ? (v as TtsRenderModeSetting) : "legacy_line";
}

export function readSceneProviderAllowlist(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.TTS_SCENE_PROVIDER_ALLOWLIST ?? "elevenlabs,fish";
  return new Set(
    raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
  );
}

export interface SceneEligibility {
  eligible: boolean;
  provider?: string;
  reason: string;
}

/** Scene mode needs EVERY speaking cast member on ONE allowlisted scene-capable
 *  engine. Anything else is an EXPLICIT, recorded fallback — never a guess and
 *  never a half-scene mix of two engines. */
export function decideSceneEligibility(opts: {
  resolvedByHostId: Map<string, ResolvedTtsVoice>;
  allowlist: Set<string>;
}): SceneEligibility {
  const providers = new Set([...opts.resolvedByHostId.values()].map((r) => r.provider));
  if (providers.size === 0) return { eligible: false, reason: "no cast voices resolved" };
  if (providers.size > 1) {
    return { eligible: false, reason: `cast resolves to multiple engines (${[...providers].join(", ")}) — scene mode requires one engine per episode` };
  }
  const provider = [...providers][0];
  if (!opts.allowlist.has(provider)) {
    return { eligible: false, provider, reason: `provider '${provider}' is not in TTS_SCENE_PROVIDER_ALLOWLIST` };
  }
  if (!providerSupportsSceneRendering(provider)) {
    return { eligible: false, provider, reason: `provider '${provider}' has no verified multi_speaker_scene capability` };
  }
  return { eligible: true, provider, reason: "all cast voices on one allowlisted scene-capable engine" };
}

function candidateCountFor(sceneType: DialogueSceneType, env: NodeJS.ProcessEnv = process.env): number {
  const n = (name: string, dflt: number) => {
    const v = Number(env[name]);
    return Number.isFinite(v) && v >= 1 && v <= 4 ? Math.floor(v) : dflt;
  };
  if (sceneType === "cold_open") return n("TTS_SCENE_CANDIDATES_COLD_OPEN", 1);
  if (sceneType === "argument_escalation") return n("TTS_SCENE_CANDIDATES_PEAK", 1);
  return n("TTS_SCENE_CANDIDATES_DEFAULT", 1);
}

/** Deterministic 32-bit seed per scene fingerprint (engines with seed support). */
export function stableSceneSeed(fingerprint: string, candidateIndex: number): number {
  const h = crypto.createHash("sha256").update(`${fingerprint}:${candidateIndex}`).digest();
  return h.readUInt32BE(0);
}

export interface SceneGenerationSummary {
  episodeId: string;
  scriptId: string;
  mode: PersistedRenderMode;
  provider?: string;
  fallbackReason?: string;
  sceneCount: number;
  readyScenes: number;
  failedScenes: number;
  reusedScenes: number;
  lineFallbackScenes: number;
  candidatesGenerated: number;
  scenes: Array<{
    sceneIndex: number;
    sceneType: string;
    lineRange: [number, number];
    status: string;
    renderUnit: string;
    reused: boolean;
    errorCategory?: string;
  }>;
  /** Set when the whole run fell back to the legacy line pipeline. */
  legacyResult?: unknown;
}

interface GenerateScenesInput {
  scriptId: string;
  forceRegenerate?: boolean;
  /** Restrict to these scene indexes (regeneration path). */
  onlySceneIndexes?: number[];
  providerOverride?: string;
  voiceOverrides?: TtsVoiceOverrides;
}

/** Load everything the planner needs and build the ScenePlan for a script. */
export async function loadScenePlanForScript(scriptId: string): Promise<{
  script: { id: string; episodeId: string; content: unknown };
  episode: { id: string; formatId: string; ttsProvider: string | null; ttsVoiceOverrides: unknown; hostIds: string[]; status: string; ttsRenderMode?: string | null };
  plan: ScenePlan;
  resolvedByHostId: Map<string, ResolvedTtsVoice>;
  castByHostId: Map<string, { host: { id: string; name: string; slug: string; role: string; speakingStyle: string; intensityLevel: number; ttsProvider: string; ttsVoiceId: string; performanceProfile?: unknown }; role: string; orderIndex: number }>;
  eligibility: SceneEligibility;
}> {
  const script = await db.script.findUnique({ where: { id: scriptId }, include: { episode: true } });
  if (!script) throw new Error(`Script ${scriptId} not found.`);
  if (!script.episode) throw new Error(`Episode not linked to script ${scriptId}.`);
  const episode = script.episode;
  const segments = (script.content as { segments?: unknown[] })?.segments;
  if (!Array.isArray(segments) || segments.length === 0) throw new Error("Script content has no valid segments.");

  const resolvedCast = await resolveEpisodeCast({
    hostIds: episode.hostIds,
    formatId: (episode as { formatId?: string }).formatId,
  });
  const castByHostId = new Map(
    resolvedCast.members.map((m) => [m.host.id, { host: m.host as never, role: m.role, orderIndex: m.orderIndex }])
  );

  const resolvedByHostId = new Map<string, ResolvedTtsVoice>();
  for (const m of resolvedCast.members) {
    resolvedByHostId.set(
      m.host.id,
      resolveTtsProviderAndVoice({
        episodeProvider: episode.ttsProvider,
        episodeVoiceOverrides: (episode.ttsVoiceOverrides as TtsVoiceOverrides | null) || null,
        host: {
          id: m.host.id,
          slug: m.host.slug,
          name: m.host.name,
          ttsProvider: m.host.ttsProvider,
          ttsVoiceId: m.host.ttsVoiceId,
        },
        envProvider: process.env.TTS_PROVIDER,
      })
    );
  }

  const eligibility = decideSceneEligibility({ resolvedByHostId, allowlist: readSceneProviderAllowlist() });
  const provider = eligibility.provider ?? [...resolvedByHostId.values()][0]?.provider ?? "stub";
  const caps = getTtsProviderCapabilities(provider);

  const lines = plannerLinesFromScriptSegments(segments as never);
  const plan = planDialogueScenes({
    scriptId,
    formatId: (episode as { formatId?: string }).formatId ?? "two_host_debate",
    lines,
    maxCharacters: caps.recommendedMaxCharacters ?? 2000,
    maxSpeakers: caps.maxSpeakers,
  });

  return {
    script: { id: script.id, episodeId: script.episodeId, content: script.content },
    episode: episode as never,
    plan,
    resolvedByHostId,
    castByHostId,
    eligibility,
  };
}

function buildSceneInput(opts: {
  scene: PlannedScene;
  plan: ScenePlan;
  episodeId: string;
  scriptId: string;
  formatId: string;
  provider: string;
  resolvedByHostId: Map<string, ResolvedTtsVoice>;
  castByHostId: Map<string, { host: { id: string; name: string; slug: string; role: string; speakingStyle: string; intensityLevel: number; performanceProfile?: unknown }; role: string; orderIndex: number }>;
  seed?: number;
  wantTimestamps: boolean;
}): DialogueSceneInput {
  const { scene } = opts;
  const utterances: SceneUtterance[] = scene.lines.map((l) => {
    const resolved = opts.resolvedByHostId.get(l.speakerHostId);
    const cast = opts.castByHostId.get(l.speakerHostId);
    if (!resolved || !cast) throw new Error(`Line ${l.lineIndex}: no cast/voice resolution for host ${l.speakerHostId}.`);
    return {
      lineIndex: l.lineIndex,
      speakerHostId: l.speakerHostId,
      speakerName: l.speakerName,
      seatIndex: cast.orderIndex,
      voiceId: resolved.voiceId,
      // Approved words only; markdown stripped, [tags] and em dashes kept.
      spokenText: sanitizeForGenericTts(l.text),
      tone: l.tone ?? undefined,
      energy: l.energy ?? undefined,
      isInterruption: l.isInterruption,
      pauseBefore: l.pauseBefore,
      segmentBoundary: scene.lines[0] === l ? scene.openedBy === "topic" ? "topic" : scene.openedBy === "segment" ? "segment" : "none" : "none",
    };
  });

  const castCtx: ScenePerformanceContext[] = scene.speakerHostIds.map((hostId) => {
    const cast = opts.castByHostId.get(hostId)!;
    const { profile } = resolveHostPerformanceProfile(cast.host.performanceProfile, cast.host);
    const overrides = opts.provider === "elevenlabs"
      ? profile.providerOverrides.elevenlabs
      : opts.provider === "fish"
        ? profile.providerOverrides.fish
        : undefined;
    return {
      speakerHostId: hostId,
      formatRoleId: cast.role,
      direction: buildPerformanceDirection({
        formatId: opts.formatId,
        roleId: cast.role,
        host: { name: cast.host.name, speakingStyle: cast.host.speakingStyle },
        profile,
        sceneType: scene.sceneType,
      }),
      intensityLevel: profile.peakIntensity,
      angerStyle: profile.angerStyle,
      maxCueDensity: profile.maxCueDensity,
      profileVersion: PERFORMANCE_PROFILE_VERSION,
      providerOverrides: overrides as Record<string, number> | undefined,
    };
  });

  return {
    episodeId: opts.episodeId,
    scriptId: opts.scriptId,
    sceneId: scene.sceneId,
    sceneIndex: scene.sceneIndex,
    sceneType: scene.sceneType,
    formatId: opts.formatId,
    utterances,
    cast: castCtx,
    seed: opts.seed,
    format: process.env.TTS_AUDIO_FORMAT === "wav" ? "wav" : "mp3",
    wantTimestamps: opts.wantTimestamps,
  };
}

/**
 * Generate scene audio for a script. Returns a summary; on ineligibility the
 * run falls back EXPLICITLY to the legacy line pipeline (recorded, logged).
 */
export async function generateDialogueScenes(input: GenerateScenesInput): Promise<SceneGenerationSummary> {
  const { scriptId, forceRegenerate = false, onlySceneIndexes } = input;
  const loaded = await loadScenePlanForScript(scriptId);
  const { plan, episode, resolvedByHostId, castByHostId, eligibility } = loaded;
  const episodeId = loaded.script.episodeId;

  const modeSetting = readRenderModeSetting();
  if (modeSetting === "legacy_line" || !eligibility.eligible) {
    const fallbackReason =
      modeSetting === "legacy_line" ? "TTS_RENDER_MODE=legacy_line" : eligibility.reason;
    console.log(`[SceneTTS] Falling back to legacy line pipeline for script ${scriptId}: ${fallbackReason}`);
    const legacyResult = await generateTtsSegments({
      scriptId,
      forceRegenerate,
      providerOverride: input.providerOverride,
      voiceOverrides: input.voiceOverrides,
    });
    await db.episode.update({ where: { id: episodeId }, data: { ttsRenderMode: "legacy_line" } });
    return {
      episodeId,
      scriptId,
      mode: "legacy_line",
      fallbackReason,
      sceneCount: 0,
      readyScenes: 0,
      failedScenes: 0,
      reusedScenes: 0,
      lineFallbackScenes: 0,
      candidatesGenerated: 0,
      scenes: [],
      legacyResult,
    };
  }

  const provider = eligibility.provider!;
  const caps = getTtsProviderCapabilities(provider);
  const formatId = (episode as { formatId?: string }).formatId ?? "two_host_debate";
  const storage = getStorageProvider();
  const ttsProvider = getTTSProvider(provider);
  const model = getTtsModelId(provider) ?? "unknown";
  const sceneModel = provider === "elevenlabs"
    ? (process.env.ELEVENLABS_DIALOGUE_MODEL_ID || process.env.ELEVENLABS_MODEL_ID || process.env.ELEVENLABS_MODEL || "eleven_v3")
    : provider === "fish"
      ? (process.env.FISH_SCENE_MODEL || "s2.1-pro-free").trim() // free-tier default — must match fishDialogue.ts (s2-pro 402s without API credit)
      : model;
  const wantTimestamps = provider === "elevenlabs" && process.env.ELEVENLABS_DIALOGUE_TIMESTAMPS !== "false";

  const summary: SceneGenerationSummary = {
    episodeId,
    scriptId,
    mode: "scene",
    provider,
    sceneCount: plan.scenes.length,
    readyScenes: 0,
    failedScenes: 0,
    reusedScenes: 0,
    lineFallbackScenes: 0,
    candidatesGenerated: 0,
    scenes: [],
  };

  const scenesToRender = onlySceneIndexes
    ? plan.scenes.filter((s) => onlySceneIndexes.includes(s.sceneIndex))
    : plan.scenes;

  for (const scene of scenesToRender) {
    const voiceMap: Record<string, string> = {};
    for (const hostId of scene.speakerHostIds) voiceMap[hostId] = resolvedByHostId.get(hostId)?.voiceId ?? "";
    const renderUnit = scene.oversized || scene.speakerHostIds.length < 1 ? "single_line" : "multi_speaker_scene";
    const fingerprint = sceneRequestFingerprint({
      scene,
      provider,
      model: sceneModel,
      renderUnit,
      voiceMap,
      seed: caps.supportsSeed ? 0 : undefined, // candidate seeds derive from this fingerprint
      plannerVersion: plan.plannerVersion,
      profileVersion: PERFORMANCE_PROFILE_VERSION,
    });

    // Idempotency: an identical ready generation is reused unless forced.
    if (!forceRegenerate) {
      const existing = await db.dialogueSceneAudio.findFirst({
        where: { scriptId, sceneIndex: scene.sceneIndex, requestFingerprint: fingerprint, status: "ready" },
        orderBy: { createdAt: "desc" },
      });
      if (existing) {
        if (!existing.selected) {
          await db.$transaction([
            db.dialogueSceneAudio.updateMany({ where: { scriptId, sceneIndex: scene.sceneIndex, selected: true }, data: { selected: false } }),
            db.dialogueSceneAudio.update({ where: { id: existing.id }, data: { selected: true } }),
          ]);
        }
        summary.reusedScenes++;
        summary.readyScenes++;
        summary.scenes.push({ sceneIndex: scene.sceneIndex, sceneType: scene.sceneType, lineRange: [scene.firstLineIndex, scene.lastLineIndex], status: "ready", renderUnit: existing.renderUnit, reused: true });
        continue;
      }
    }

    const candidates = candidateCountFor(scene.sceneType);
    let sceneReady = false;
    let sceneRenderUnit = renderUnit;
    let firstError: SceneGenerationError | null = null;

    // Force-regenerate: deselect prior candidates ONCE, before new ones land,
    // so a retry can never leave two selected rows.
    if (forceRegenerate) {
      await db.dialogueSceneAudio.updateMany({
        where: { scriptId, sceneIndex: scene.sceneIndex, selected: true },
        data: { selected: false },
      });
    }

    // How many candidates already exist for this fingerprint (retries must
    // extend the series, not duplicate index 0).
    const priorCandidates = await db.dialogueSceneAudio.count({ where: { scriptId, sceneIndex: scene.sceneIndex, requestFingerprint: fingerprint } });

    for (let c = 0; c < candidates; c++) {
      const candidateIndex = priorCandidates + c;
      const seed = caps.supportsSeed ? stableSceneSeed(fingerprint, candidateIndex) : undefined;
      const row = await db.dialogueSceneAudio.create({
        data: {
          episodeId,
          scriptId,
          sceneIndex: scene.sceneIndex,
          sceneType: scene.sceneType,
          firstLineIndex: scene.firstLineIndex,
          lastLineIndex: scene.lastLineIndex,
          lineIndexes: scene.lineIndexes,
          provider,
          model: sceneModel,
          renderUnit: sceneRenderUnit,
          voiceMap,
          requestFingerprint: fingerprint,
          candidateIndex,
          seed: seed ?? null,
          status: "processing",
          plannerVersion: plan.plannerVersion,
        },
      });

      try {
        let audioBuffer: Buffer;
        let contentType: string;
        let durationMs: number | undefined;
        let timingStatus = "timing_unavailable";
        let timingMap: unknown = null;
        let providerMetadata: Record<string, unknown> | undefined;
        let usedModel = sceneModel;
        let endpoint = "";

        if (renderUnit === "multi_speaker_scene" && isDialogueSceneProvider(ttsProvider)) {
          const sceneInput = buildSceneInput({
            scene, plan, episodeId, scriptId, formatId, provider,
            resolvedByHostId, castByHostId: castByHostId as never, seed, wantTimestamps,
          });
          const res = await ttsProvider.synthesizeDialogueScene(sceneInput);
          audioBuffer = res.audioBuffer;
          contentType = res.contentType;
          durationMs = res.durationMs;
          usedModel = res.model;
          endpoint = res.endpoint;
          providerMetadata = res.providerMetadata;
          if (res.timingMap && res.timingMap.utterances.length === scene.lines.length) {
            timingStatus = res.timingMap.status;
            timingMap = res.timingMap.utterances;
          }
          sceneRenderUnit = res.renderUnit;
        } else {
          // Oversized single line (or a provider losing scene support mid-run):
          // EXPLICIT per-line fallback for exactly this scene, recorded as such.
          sceneRenderUnit = "single_line";
          const l = scene.lines[0];
          const resolved = resolvedByHostId.get(l.speakerHostId)!;
          const res = await ttsProvider.synthesizeSpeech({
            text: sanitizeForGenericTts(l.text),
            voiceId: resolved.voiceId,
            speakerName: l.speakerName,
            tone: l.tone ?? undefined,
            energy: (l.energy as "low" | "medium" | "high") ?? undefined,
            isInterruption: l.isInterruption === true,
            format: process.env.TTS_AUDIO_FORMAT === "wav" ? "wav" : "mp3",
          });
          audioBuffer = res.audioBuffer;
          contentType = res.contentType;
          durationMs = res.durationMs;
          endpoint = "single-speaker (oversized-line fallback)";
          summary.lineFallbackScenes++;
        }

        if (!audioBuffer || audioBuffer.length === 0) {
          throw new SceneGenerationError("empty_audio", "Provider returned an empty audio buffer.");
        }

        const ext = (process.env.TTS_AUDIO_FORMAT === "wav" ? "wav" : "mp3");
        const storageKey = `episodes/${episodeId}/scripts/${scriptId}/scenes/${scene.sceneIndex}-c${candidateIndex}.${ext}`;
        let uploadUrl: string;
        try {
          const up = await storage.putObject({ key: storageKey, body: audioBuffer, contentType });
          uploadUrl = up.url;
        } catch (err) {
          throw new SceneGenerationError("storage_failed", `Scene upload failed: ${(err as Error).message}`);
        }

        await db.dialogueSceneAudio.update({
          where: { id: row.id },
          data: {
            status: "ready",
            renderUnit: sceneRenderUnit,
            model: usedModel,
            audioUrl: uploadUrl,
            durationMs: durationMs ?? null,
            contentType,
            timingStatus,
            timingMap: timingMap as never,
            providerMetadata: ({ ...(providerMetadata ?? {}), endpoint } as never),
            // First successful candidate is selected by default; operators can
            // re-pick among candidates before publication.
            selected: !sceneReady,
          },
        });
        summary.candidatesGenerated++;
        sceneReady = true;
      } catch (err) {
        const category: SceneErrorCategory =
          err instanceof SceneGenerationError ? err.category : "unknown_provider_failure";
        await db.dialogueSceneAudio.update({
          where: { id: row.id },
          data: { status: "failed", errorCategory: category, selected: false },
        });
        console.error(`[SceneTTS] Scene ${scene.sceneIndex} candidate ${candidateIndex} failed (${category}): ${(err as Error).message}`);
        if (!firstError) firstError = err instanceof SceneGenerationError ? err : new SceneGenerationError(category, (err as Error).message);
      }
    }

    if (sceneReady) {
      summary.readyScenes++;
    } else {
      summary.failedScenes++;
    }
    summary.scenes.push({
      sceneIndex: scene.sceneIndex,
      sceneType: scene.sceneType,
      lineRange: [scene.firstLineIndex, scene.lastLineIndex],
      status: sceneReady ? "ready" : "failed",
      renderUnit: sceneRenderUnit,
      reused: false,
      ...(sceneReady ? {} : { errorCategory: firstError?.category ?? "unknown_provider_failure" }),
    });
  }

  // Persist the decision that was ACTUALLY taken.
  summary.mode = summary.lineFallbackScenes > 0 ? "mixed_fallback" : "scene";
  await db.episode.update({ where: { id: episodeId }, data: { ttsRenderMode: summary.mode } });

  // Advance the episode exactly like the line pipeline once every scene of the
  // FULL plan is ready (partial/regen runs check the whole plan).
  const readyRows = await db.dialogueSceneAudio.findMany({
    where: { scriptId, status: "ready", selected: true },
    select: { sceneIndex: true },
  });
  const readySet = new Set(readyRows.map((r) => r.sceneIndex));
  if (plan.scenes.every((s) => readySet.has(s.sceneIndex))) {
    await db.episode.updateMany({
      where: { id: episodeId, status: "fact_checked" },
      data: { status: "audio_segments_ready" },
    });
  }

  return summary;
}

/** The selected, ready scene rows for a script in scene order. */
export async function getSelectedSceneAudio(scriptId: string) {
  return db.dialogueSceneAudio.findMany({
    where: { scriptId, status: "ready", selected: true },
    orderBy: { sceneIndex: "asc" },
  });
}

/** Regeneration entry: one edited line → its whole containing scene. */
export async function regenerateSceneForLine(scriptId: string, lineIndex: number): Promise<{
  sceneIndex: number;
  firstLineIndex: number;
  lastLineIndex: number;
  summary: SceneGenerationSummary;
}> {
  const { plan } = await loadScenePlanForScript(scriptId);
  const scene = resolveSceneForLine(plan, lineIndex);
  if (!scene) throw new Error(`Line ${lineIndex} is not part of any planned scene for script ${scriptId}.`);
  const summary = await generateDialogueScenes({
    scriptId,
    forceRegenerate: true,
    onlySceneIndexes: [scene.sceneIndex],
  });
  return {
    sceneIndex: scene.sceneIndex,
    firstLineIndex: scene.firstLineIndex,
    lastLineIndex: scene.lastLineIndex,
    summary,
  };
}

export { SCENE_PLANNER_VERSION };
