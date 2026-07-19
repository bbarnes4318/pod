import { db } from "@/lib/db";
import { getStorageProvider } from "@/lib/providers/storage/factory";
import fs from "fs";
import path from "path";
import os from "os";
import {
  PlannedLine,
  TimelineClip,
  getFileDurationMs,
  masterToMp3,
  measureEdgeSilenceMs,
  planConversationTimeline,
  renderTimelineToWav,
  runFfmpeg,
  standardizeClipToWav,
} from "@/lib/audio/assembly";
import { AudioQaReport, analyzeEpisodeAudio } from "@/lib/audio/audioQa";
import { verifyBookends, resolveBookendRequirement, describeBookendAbsence, type BookendVerification, type BookendKind } from "@/lib/audio/bookendQa";
import { buildRenderDiagnostics, RENDER_DIAGNOSTICS_VERSION, scrubSafeText } from "@/lib/audio/renderDiagnostics";
import {
  LoadedAsset,
  ProductionStyle,
  SfxCategory,
  SfxDensity,
  SfxLineContext,
  SoundDesignAssetSet,
  SoundDesignSummary,
  emptyAssetSet,
  isProductionStyle,
  isSfxDensity,
  mixBedUnderForeground,
  parseEpisodeSoundDesign,
  pickSfxAsset,
  planReactionSfx,
  planStingers,
  shiftTimelineForInsert,
} from "@/lib/audio/soundDesign";
import { hasLineIndexCollisions } from "@/lib/services/scriptRepetition";
import type { ProductionPlan } from "@/lib/audio/productionPlan";
import {
  PlannerAsset,
  generateProductionPlan,
  isSoundDesignPlannerEnabled,
  plannerLinesFromScriptContent,
  resolvePlannerConfig,
} from "@/lib/audio/productionPlanner";
import {
  DEFAULT_STINGER_ROOM_CAP_MS,
  applyPlannedStingerRoom,
  applyRotationStingerRoom,
  executePlanOnTimeline,
  plannedStingerDurations,
  resolveIntroFromPlan,
} from "@/lib/audio/planExecution";
import { readCooldownSnapshot, recordPlanUsage, type CooldownScopeFilter } from "@/lib/services/cueCooldownService";
import { resolveEpisodeCast, makeCastMatchers } from "@/lib/services/hostCasting";
import { resolvePodcastSoundProfile, type FrozenSoundProfile } from "@/lib/services/podcastSoundProfile";
import { rightsUsableForNewUse } from "@/lib/services/audioAssetAccess";
import { resolveSnapshotSoundProfile, frozenBookendEnabled } from "@/lib/services/episodeConfigurationSnapshot";
import crypto from "crypto";

/** The frozen sound profile from an Episode configuration snapshot, via the
 *  ONE canonical resolver (shape-keyed, every profile-bearing version — v2, v3,
 *  and beyond). null for legacy / v1 / profile-less snapshots (compatibility
 *  path). A snapshot that CLAIMS a profile but whose profile is structurally
 *  invalid throws — we refuse to render with the wrong (legacy global) pool
 *  rather than silently degrade an episode's sound identity. */
function frozenProfileFromEpisode(episode: { configurationSnapshot: unknown }): FrozenSoundProfile | null {
  const { profile, status } = resolveSnapshotSoundProfile(episode.configurationSnapshot);
  if (status === "corrupt") {
    throw new Error(
      "Episode configuration snapshot has a structurally invalid frozen sound profile - refusing to render with the wrong sound pool."
    );
  }
  return profile;
}

interface StitchInput {
  scriptId: string;
  forceRegenerate?: boolean;
  includeIntro?: boolean;
  includeOutro?: boolean;
  normalizeAudio?: boolean;
  targetLufs?: number;
  /** "clean" | "light" | "full" — post-production depth. Falls back to the
   *  episode's saved setting, then the show config default. */
  productionStyle?: string;
  /** "subtle" | "medium" | "hype" — reaction-SFX density (full style only). */
  sfxDensity?: string;
  /** Prompt 6 render semantics. Default (unset): a fresh render is "initial";
   *  a forced re-render of a snapshot-v2 episode uses the episode's FROZEN
   *  profile ("remix_episode_profile" — the safest backward-compatible
   *  choice); legacy episodes keep their legacy behavior.
   *    "reproduce"              re-execute the reference render's EXACT plan,
   *                             verifying every asset's content hash;
   *    "remix_episode_profile"  new deterministic plan from the frozen pool;
   *    "remix_current_podcast"  EXPLICIT producer action: re-resolve the
   *                             CURRENT podcast profile (sound may differ). */
  renderMode?: "reproduce" | "remix_episode_profile" | "remix_current_podcast";
}

/** Script rubric (70%) + audio human-ness checks (30%) → 0-100. */
function computeEpisodeScore(scriptQuality: any, qaReport: AudioQaReport | null) {
  const scriptScore = typeof scriptQuality?.total === "number" ? scriptQuality.total : null;
  let audioScore: number | null = null;
  if (qaReport && Array.isArray(qaReport.checks) && qaReport.checks.length > 0) {
    const pts = qaReport.checks.reduce(
      (a, c) => a + (c.status === "pass" ? 1 : c.status === "warning" ? 0.5 : 0),
      0
    );
    audioScore = Math.round((pts / qaReport.checks.length) * 100);
  }
  if (scriptScore === null && audioScore === null) return null;
  const total = Math.round((scriptScore ?? 60) * 0.7 + (audioScore ?? 60) * 0.3);
  return { total, scriptScore, audioScore, scriptAxes: scriptQuality?.axes ?? null };
}

/**
 * Download + standardize every sound-design asset this stitch needs.
 * Failures are downgraded to warnings — a missing stinger must never sink an
 * episode render. Highlights are rights-gated: only active `highlight`
 * assets with rightsConfirmed=true are ever loaded.
 */
export async function loadSoundDesignAssetSet(opts: {
  style: ProductionStyle;
  config: {
    themeIntroAssetId: string | null;
    themeOutroAssetId: string | null;
    bedAssetId: string | null;
    stingerAssetIds: unknown;
  } | null;
  highlightAssetIds: string[];
  /** Additional asset ids to download (planner-selected stingers/beds that
   *  may not be in the show config). */
  extraAssetIds?: string[];
  /** Prompt 6: the episode's FROZEN sound profile. When present, the loader is
   *  ISOLATED to it — slots/stingers come from the profile, the reaction pool
   *  is ONLY the frozen reaction list (never the whole active library), and
   *  every downloaded asset is verified against its frozen content hash. */
  frozenProfile?: FrozenSoundProfile | null;
  tempDir: string;
  storageProvider: { getObject(i: { url: string }): Promise<{ body: Buffer }> };
  ffmpegPath: string;
  ffprobePath: string;
  sampleRate: number;
  warnings: string[];
}): Promise<SoundDesignAssetSet> {
  const set = emptyAssetSet();
  const frozen = opts.frozenProfile ?? null;
  const cfg = frozen
    ? {
        themeIntroAssetId: frozen.intro?.assetId ?? null,
        themeOutroAssetId: frozen.outro?.assetId ?? null,
        bedAssetId: frozen.bed?.assetId ?? null,
        stingerAssetIds: frozen.stingers.map((s) => s.assetId),
      }
    : opts.config;
  const stingerIds: string[] = Array.isArray(cfg?.stingerAssetIds)
    ? (cfg!.stingerAssetIds as unknown[]).filter((s): s is string => typeof s === "string")
    : [];

  const configuredIds = [
    cfg?.themeIntroAssetId,
    cfg?.themeOutroAssetId,
    cfg?.bedAssetId,
    ...stingerIds,
    ...(frozen ? frozen.reactions.map((r) => r.assetId) : []),
    ...opts.highlightAssetIds,
    ...(opts.extraAssetIds ?? []),
  ].filter((id): id is string => !!id);

  // Expected content hashes from the frozen profile — a downloaded object
  // that does not match is a media-integrity failure and is never mixed.
  const expectedHash = new Map<string, string>();
  if (frozen) {
    for (const ref of [frozen.intro, frozen.outro, frozen.bed, ...frozen.stingers, ...frozen.reactions]) {
      if (ref?.contentHash) expectedHash.set(ref.assetId, ref.contentHash);
    }
  }

  const rows = await db.audioAsset.findMany({
    where: frozen
      ? // ISOLATED: exactly the frozen profile + explicit highlights — nothing
        // outside the episode's permitted pool is even fetched from the DB.
        { id: { in: configuredIds.length > 0 ? configuredIds : ["-"] } }
      : {
          isActive: true,
          OR: [
            { id: { in: configuredIds.length > 0 ? configuredIds : ["-"] } },
            // LEGACY episodes (no frozen profile): reactions were historically
            // "the whole active pool". That pool is now scope-guarded — only
            // system-side assets qualify; another owner's private SFX can
            // never leak into a legacy render.
            { kind: "sfx", scope: { in: ["shared_system", "legacy_global"] }, isArchived: false },
          ],
        },
  });

  // Per-kind loudness targets: themes near speech, bed/SFX prepared for
  // their mix gains, highlights at speech level (they ARE content).
  const lufsForKind: Record<string, number> = {
    theme_intro: -17,
    theme_outro: -17,
    bed: -18,
    stinger: -16,
    sfx: -16,
    highlight: -18,
  };

  const prepared = new Map<string, LoadedAsset>();
  for (const row of rows) {
    // Rights gate: an unconfirmed highlight is never mixed in.
    if (row.kind === "highlight" && !row.rightsConfirmed) {
      opts.warnings.push(`Highlight asset '${row.name}' skipped: rights not confirmed.`);
      continue;
    }
    // Render-time rights revalidation (Prompt 6): rights revoked/expired/
    // rejected SINCE the episode froze its profile block the asset now — it is
    // skipped with a warning, never silently substituted. (Archive status is
    // deliberately NOT re-checked here: an archived-but-rights-valid asset may
    // still voice a render of an episode whose snapshot references it.)
    {
      const rights = rightsUsableForNewUse(row);
      if (!rights.ok) {
        opts.warnings.push(`Sound asset '${row.name}' skipped: rights invalid (${rights.error.code}).`);
        continue;
      }
    }
    try {
      const rawPath = path.join(opts.tempDir, `asset-${row.id}-raw`);
      const res = await opts.storageProvider.getObject({ url: row.audioUrl });
      // Bounded download: an asset object larger than the platform cap is
      // refused rather than buffered into the mix.
      const maxBytes = Number(process.env.AUDIO_ASSET_MAX_BYTES) || 200 * 1024 * 1024;
      if (res.body.length === 0 || res.body.length > maxBytes) {
        throw new Error(`asset object size ${res.body.length} outside bounds`);
      }
      // Media integrity: when the episode froze a content hash for this asset,
      // the downloaded bytes MUST match — a mismatch is never mixed and never
      // silently substituted. (The safe message carries no URL.)
      const wantHash = expectedHash.get(row.id) ?? row.contentHash ?? null;
      if (wantHash) {
        const gotHash = crypto.createHash("sha256").update(res.body).digest("hex");
        if (gotHash !== wantHash) {
          try {
            await db.audioAssetAuditEvent.create({
              data: { assetId: row.id, event: "metadata_failed", actorType: "system", metadata: { reason: "content_hash_mismatch_at_render" } },
            });
          } catch { /* audit is best-effort */ }
          throw new Error("content hash mismatch (media integrity) — flagged for review");
        }
      }
      fs.writeFileSync(rawPath, res.body);
      const wavPath = path.join(opts.tempDir, `asset-${row.id}.wav`);
      await standardizeClipToWav(opts.ffmpegPath, rawPath, wavPath, {
        sampleRate: opts.sampleRate,
        targetLufs: lufsForKind[row.kind] ?? -17,
      });
      const durationMs = await getFileDurationMs(opts.ffprobePath, wavPath);
      prepared.set(row.id, {
        id: row.id,
        name: row.name,
        kind: row.kind,
        category: row.category,
        filePath: wavPath,
        durationMs,
      });
    } catch (err: any) {
      opts.warnings.push(`Sound asset '${row.name}' failed to load (${err.message}) — skipped.`);
    }
  }

  if (cfg?.themeIntroAssetId) set.intro = prepared.get(cfg.themeIntroAssetId) ?? null;
  if (cfg?.themeOutroAssetId) set.outro = prepared.get(cfg.themeOutroAssetId) ?? null;
  if (cfg?.bedAssetId) set.bed = prepared.get(cfg.bedAssetId) ?? null;
  set.stingers = stingerIds
    .map((id) => prepared.get(id))
    .filter((a): a is LoadedAsset => !!a);
  for (const asset of prepared.values()) {
    if (asset.kind === "sfx" && asset.category) {
      const cat = asset.category as SfxCategory;
      const pool = set.sfxByCategory.get(cat) || [];
      pool.push(asset);
      set.sfxByCategory.set(cat, pool);
    }
    if (asset.kind === "highlight") set.highlights.set(asset.id, asset);
  }
  set.byId = prepared;
  return set;
}

export async function stitchFinalEpisodeAudio(input: StitchInput) {
  const {
    scriptId,
    forceRegenerate = false,
    // Default ON: the show theme belongs on every render. Callers that omit
    // these flags (studio mixEpisode, the auto-pipeline, line-regen re-splice)
    // were silently shipping theme-less episodes while the admin console —
    // whose checkboxes default on — produced correct ones. A missing theme
    // asset/env URL still degrades to a logged skip, so true is safe even on
    // unconfigured shows.
    includeIntro = true,
    includeOutro = true,
    normalizeAudio = true,
    targetLufs = -16,
  } = input;

  const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
  const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";

  // Create JobLog in running state
  const jobLog = await db.jobLog.create({
    data: {
      jobType: "audio:stitch-final",
      status: "running",
      input: {
        scriptId,
        forceRegenerate,
        includeIntro,
        includeOutro,
        normalizeAudio,
        targetLufs,
        productionStyle: input.productionStyle,
        sfxDensity: input.sfxDensity,
      } as any,
      output: {},
    },
  });

  let previousStatus = "audio_segments_ready";
  let scriptRecord: any = null;
  let renderRecordId: string | null = null;

  try {
    // 1. Script & Episode Existence
    scriptRecord = await db.script.findUnique({
      where: { id: scriptId },
      include: { episode: true },
    });

    if (!scriptRecord) {
      throw new Error(`Script with ID ${scriptId} not found.`);
    }

    const script = scriptRecord;
    const episode = script.episode;

    if (!episode) {
      throw new Error(`Episode not linked to Script ${scriptId}.`);
    }

    previousStatus = episode.status;

    if (episode.status === "audio_stitching") {
      throw new Error("Episode is already audio_stitching. Wait for the current stitch job to finish or manually reset the status.");
    }

    // Skip check if already complete and forceRegenerate is false
    if (episode.status === "audio_ready" && !forceRegenerate) {
      const output = {
        episodeId: episode.id,
        scriptId,
        finalStatus: "skipped",
        finalAudioUrl: episode.audioUrl,
        durationSeconds: episode.durationSeconds || 0,
        lineCount: 0,
        audioSegmentCount: 0,
        missingSegmentCount: 0,
        failedSegmentCount: 0,
        duplicateSegmentCount: 0,
        totalInputDurationMs: 0,
        finalFileSizeBytes: 0,
        ffmpegCommandSummary: "skipped",
        storageKey: "",
        reasons: ["Final audio already exists and forceRegenerate is false."],
      };

      await db.jobLog.update({
        where: { id: jobLog.id },
        data: {
          status: "skipped",
          output: output as any,
        },
      });

      return output;
    }

    // 2. Validate Eligibility Gates
    if (script.status !== "approved") {
      throw new Error(`Script status is '${script.status}'. Stitching is only allowed for approved scripts.`);
    }

    if (!script.content || typeof script.content !== "object") {
      throw new Error("Script content is missing or not structured JSON.");
    }

    if (!script.plainText || !script.plainText.trim()) {
      throw new Error("Script plainText transcript is empty.");
    }

    // Accept fact_checked too: the audio-segments_ready flag only flips inside
    // the TTS job, so it can lag even when every line's audio is ready. The
    // per-line readiness check below is the real gate.
    //
    // A forced re-mix of an ALREADY-produced episode is also allowed — audio_ready
    // or any later stage (content_ready, publish_ready, published). This is how
    // "add music to a finished episode" works. The episode's later status is
    // preserved after the re-stitch (see finalEpisodeStatus below), so a re-mix
    // never knocks a published episode back to audio_ready.
    const PRODUCED_OR_LATER = new Set([
      "audio_ready",
      "content_generating",
      "content_ready",
      "publish_ready",
      "published",
    ]);
    if (
      episode.status !== "audio_segments_ready" &&
      episode.status !== "fact_checked" &&
      !(PRODUCED_OR_LATER.has(episode.status) && forceRegenerate)
    ) {
      throw new Error(`Episode status is '${episode.status}'. Stitching requires 'audio_segments_ready' (or a forced re-mix of an already-produced episode).`);
    }

    const latestFactCheck = await db.factCheckResult.findFirst({
      where: { scriptId },
      orderBy: { checkedAt: "desc" },
    });

    if (!latestFactCheck) {
      throw new Error("No fact check result exists for this script.");
    }

    if (latestFactCheck.status !== "passed") {
      throw new Error(`Latest fact check status is '${latestFactCheck.status}'. Fact check must pass to stitch final audio.`);
    }

    const segments = (script.content as any).segments;
    if (!Array.isArray(segments) || segments.length === 0) {
      throw new Error("Script segments are missing or empty.");
    }

    // HARD GUARD against the repeated-clip bug: if the script content has
    // duplicate lineIndex values, one audio clip would be stitched in for
    // every colliding line (same sentence over and over). Refuse and point
    // at the fix — re-running TTS renumbers and regenerates automatically.
    if (hasLineIndexCollisions(segments)) {
      throw new Error(
        "Script has duplicate lineIndex values (would stitch the same clip repeatedly). Re-run TTS generation — it renumbers the script and regenerates segments automatically."
      );
    }

    // Resolve the two hosts this episode was cast with (no hardcoded names).
    // FORMAT-driven cast (1-4 voices; the debate delegates to the legacy pair
    // resolver so existing episodes stitch identically).
    const resolvedEpisodeCast = await resolveEpisodeCast({
      hostIds: episode.hostIds,
      formatId: (episode as { formatId?: string }).formatId,
    });
    const stitchCast = resolvedEpisodeCast.members.map((m) => m.host);
    const speakers = makeCastMatchers(stitchCast);

    // Flatten script lines
    const allLines: any[] = [];
    for (let sIdx = 0; sIdx < segments.length; sIdx++) {
      const seg = segments[sIdx];
      if (!seg || !Array.isArray(seg.lines)) {
        throw new Error(`Segment at index ${sIdx} is invalid.`);
      }

      for (let lIdx = 0; lIdx < seg.lines.length; lIdx++) {
        const line = seg.lines[lIdx];
        if (
          line.lineIndex === undefined ||
          line.speakerName === undefined ||
          line.speakerHostId === undefined ||
          line.text === undefined ||
          line.tone === undefined ||
          line.isFactualClaim === undefined ||
          line.needsHumanReview === undefined ||
          !Array.isArray(line.evidenceRefs)
        ) {
          throw new Error(`Script line at segment ${sIdx}, index ${lIdx} is missing required fields.`);
        }

        // Not a hard block: stitching runs only on approved, fact-checked
        // scripts (a human has signed off). Approval clears these flags going
        // forward; older approved scripts proceed with a logged warning.
        if (line.needsHumanReview === true) {
          console.warn(`[Stitcher] Line ${line.lineIndex} flagged needsHumanReview but script is approved; proceeding.`);
        }

        const lineHost = speakers.hostForSpeaker(line.speakerName);
        if (!lineHost) {
          throw new Error(`Line ${line.lineIndex} has invalid speakerName '${line.speakerName}'. Allowed for this episode: ${stitchCast.map((h) => h.name).join(", ")}.`);
        }
        if (line.speakerHostId !== lineHost.id) {
          throw new Error(`Line ${line.lineIndex} host ID does not match the cast profile for ${lineHost.name}.`);
        }

        allLines.push(line);
      }
    }

    const lineCount = allLines.length;

    // Load and check AudioSegment records
    const audioSegments = await db.audioSegment.findMany({
      where: { scriptId },
    });

    let missingSegmentCount = 0;
    let failedSegmentCount = 0;
    let duplicateSegmentCount = 0;
    const segmentMap = new Map<number, any[]>();

    for (const segment of audioSegments) {
      const list = segmentMap.get(segment.lineIndex) || [];
      list.push(segment);
      segmentMap.set(segment.lineIndex, list);
    }

    const validatedSegments: any[] = [];

    for (const line of allLines) {
      const segmentsForLine = segmentMap.get(line.lineIndex) || [];
      if (segmentsForLine.length > 1) {
        // Duplicate rows are tolerated — we just pick the usable one below.
        duplicateSegmentCount++;
      }

      // Prefer a ready segment with audio among any duplicates for this line.
      const activeSeg =
        segmentsForLine.find((s) => s.status === "ready" && s.audioUrl) || segmentsForLine[0];

      if (!activeSeg) {
        missingSegmentCount++;
      } else if (activeSeg.status !== "ready" || !activeSeg.audioUrl) {
        failedSegmentCount++;
      } else {
        validatedSegments.push(activeSeg);
      }
    }

    // Duplicates are NOT a hard failure; only genuinely missing or unusable
    // (not-ready / no-audio) lines block stitching.
    if (missingSegmentCount > 0 || failedSegmentCount > 0) {
      throw new Error(
        `AudioSegment validation failed. Missing: ${missingSegmentCount}, Failed/Not Ready: ${failedSegmentCount} (duplicates tolerated: ${duplicateSegmentCount}).`
      );
    }

    // Transition Episode status to audio_stitching safely
    await db.episode.update({
      where: { id: episode.id },
      data: { status: "audio_stitching" },
    });

    // 3. Temporary Workspace Setup
    const tempBaseDir = process.env.AUDIO_STITCH_TEMP_DIR || path.join(os.tmpdir(), "take-machine-audio");
    const jobId = jobLog.id;
    const tempDir = path.join(tempBaseDir, episode.id, scriptId, jobId);
    fs.mkdirSync(tempDir, { recursive: true });

    const storageProvider = getStorageProvider();

    // 3a-bis. Prompt 6 render semantics: resolve the episode's PERMITTED sound
    // pool and the render mode, and open the immutable render-version record.
    let frozenProfile = frozenProfileFromEpisode(episode);
    const renderMode: string = input.renderMode
      ? input.renderMode
      : frozenProfile
        ? forceRegenerate
          ? "remix_episode_profile" // safest backward-compatible re-render default
          : "initial"
        : "legacy";

    if (renderMode === "remix_current_podcast") {
      // EXPLICIT producer action only: re-resolve the CURRENT podcast profile.
      // The episode's stored snapshot is NOT rewritten — this render's record
      // carries what was used.
      if (episode.podcastId) {
        const pod = await db.podcast.findUnique({
          where: { id: episode.podcastId },
          select: { id: true, ownerId: true, productionConfig: true },
        });
        if (pod) frozenProfile = await resolvePodcastSoundProfile(db, { id: pod.id, ownerId: pod.ownerId }, pod.productionConfig);
      }
    }

    // Reproduce: load the reference render's EXACT stored plan. No reference
    // plan -> a clear failure, never a silent re-pick.
    let reproducePlan: ProductionPlan | null = null;
    if (renderMode === "reproduce") {
      const reference = await db.episodeAudioRender.findFirst({
        where: { episodeId: episode.id, status: "succeeded" },
        orderBy: { renderVersion: "desc" },
      });
      if (!reference?.plan) {
        throw new Error("Reproduce requested but no prior render with a stored plan exists for this episode.");
      }
      reproducePlan = reference.plan as unknown as ProductionPlan;
    }

    const priorVersion = await db.episodeAudioRender.aggregate({
      where: { episodeId: episode.id },
      _max: { renderVersion: true },
    });
    const renderRecord = await db.episodeAudioRender.create({
      data: {
        episodeId: episode.id,
        scriptId,
        renderVersion: (priorVersion._max.renderVersion ?? 0) + 1,
        status: "running",
        renderMode,
        configurationFingerprint: episode.configurationFingerprint ?? null,
        targetLoudnessLufs: frozenProfile?.targetLoudnessLufs ?? null,
      },
    });
    renderRecordId = renderRecord.id;

    // 3b. Sound design resolution: trigger option > episode setting > show
    // config default > "clean" (legacy dialogue-only render). See
    // docs/SOUND_DESIGN.md for the full production model.
    const episodeSound = parseEpisodeSoundDesign(episode.soundDesign);
    const sdConfig = await db.soundDesignConfig.findUnique({ where: { id: "default" } });
    let style: ProductionStyle = isProductionStyle(input.productionStyle)
      ? input.productionStyle
      : episodeSound.style ??
        (sdConfig && isProductionStyle(sdConfig.defaultStyle) ? sdConfig.defaultStyle : "clean");
    // A frozen CLEAN profile is dialogue-only by definition — no style input
    // can add sound the episode's configuration forbids.
    if (frozenProfile?.mode === "clean") style = "clean";
    const sfxDensity: SfxDensity = isSfxDensity(input.sfxDensity)
      ? input.sfxDensity
      : episodeSound.sfxDensity ??
        (sdConfig && isSfxDensity(sdConfig.defaultSfxDensity) ? sdConfig.defaultSfxDensity : "subtle");
    const highlightPlacements = episodeSound.highlights ?? [];

    const soundWarnings: string[] = [];

    // 3c. SOUND_DESIGN_PLANNER (flag, default off): generate the per-episode
    // ProductionPlan BEFORE loading audio. The planner selects cues from the
    // whole active library using the script's own signal + the cross-episode
    // cooldown ledger; we then download exactly the assets the plan uses.
    // Flag off → productionPlan stays null and the legacy path below runs
    // unchanged.
    const plannerEnabled = isSoundDesignPlannerEnabled() && style !== "clean";
    let productionPlan: ProductionPlan | null = null;
    if (plannerEnabled && reproducePlan) {
      // REPRODUCE: execute the reference render's exact stored plan. The
      // planner is not consulted, current assignments are not consulted, and
      // every plan asset's bytes are hash-verified at load time below.
      productionPlan = reproducePlan;
      console.log(`[Stitcher] Reproducing stored plan: ${productionPlan.cues.length} cues (seed=${productionPlan.seed})`);
    } else if (plannerEnabled) {
      const plannerConfig = resolvePlannerConfig();
      // Frozen-profile cooldown overrides (per-show settings beat env).
      if (frozenProfile?.stingerCooldownEpisodes != null) plannerConfig.cooldownEpisodes = frozenProfile.stingerCooldownEpisodes;
      if (frozenProfile?.reactionCooldownEpisodes != null) plannerConfig.sfxCooldownEpisodes = frozenProfile.reactionCooldownEpisodes;

      // CATALOG ISOLATION (Prompt 6): a snapshot-v2 episode's planner sees
      // ONLY its frozen pool. Legacy episodes fall back to the system-side
      // library (scope-guarded — never another owner's private assets).
      let catalog: PlannerAsset[];
      if (frozenProfile) {
        const refs = [
          frozenProfile.intro, frozenProfile.outro, frozenProfile.bed,
          ...frozenProfile.stingers, ...frozenProfile.reactions,
        ].filter((r): r is NonNullable<typeof r> => !!r);
        catalog = refs.map((r) => ({
          id: r.assetId,
          name: r.name,
          kind: r.kind,
          category: r.category,
          durationMs: r.durationMs ?? undefined,
          tags: r.tags,
        }));
      } else {
        const catalogRows = await db.audioAsset.findMany({
          where: {
            isActive: true,
            isArchived: false,
            kind: { in: ["theme_intro", "theme_outro", "stinger", "bed", "sfx"] },
            scope: { in: ["shared_system", "legacy_global"] },
          },
        });
        catalog = catalogRows.map((r) => ({
          id: r.id,
          name: r.name,
          kind: r.kind,
          category: r.category,
          durationMs: r.durationMs ?? undefined,
          // Metadata-aware selection reads bpm:/energy:/mood tags + the ES title.
          tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
        }));
      }

      // COOLDOWN ISOLATION (Prompt 6): scoped to the podcast (default) or the
      // owner — never global. Ownerless internal episodes use the explicit
      // system scope. Another customer's usage cannot reach this query.
      const cooldownScope: CooldownScopeFilter =
        frozenProfile?.cooldownScope === "owner" && episode.ownerId
          ? { kind: "owner", ownerId: episode.ownerId }
          : episode.podcastId
            ? { kind: "podcast", podcastId: episode.podcastId }
            : episode.ownerId
              ? { kind: "owner", ownerId: episode.ownerId }
              : { kind: "system" };
      const cooldown = await readCooldownSnapshot({
        episodeCount: Math.max(plannerConfig.cooldownEpisodes, plannerConfig.sfxCooldownEpisodes),
        scope: cooldownScope,
        excludeEpisodeId: episode.id,
      });
      productionPlan = generateProductionPlan({
        episodeId: episode.id,
        scriptId,
        style,
        sfxDensity,
        lines: plannerLinesFromScriptContent(segments),
        assets: catalog,
        cooldown,
        config: plannerConfig,
        includeIntro: includeIntro && (frozenProfile ? frozenProfile.intro !== null : true),
        includeOutro: includeOutro && (frozenProfile ? frozenProfile.outro !== null : true),
        introAssetId: frozenProfile ? (frozenProfile.intro?.assetId ?? null) : (sdConfig?.themeIntroAssetId ?? null),
        outroAssetId: frozenProfile ? (frozenProfile.outro?.assetId ?? null) : (sdConfig?.themeOutroAssetId ?? null),
        // v2 episodes never fall back to env URLs the snapshot did not capture.
        envIntroFallback: !frozenProfile && !!process.env.AUDIO_INTRO_URL,
        envOutroFallback: !frozenProfile && !!process.env.AUDIO_OUTRO_URL,
        highlights: highlightPlacements,
      });
      console.log(
        `[Stitcher] Production plan: ${productionPlan.cues.length} cues ` +
          `(stingers=${productionPlan.stats.stingerCues}, reactions=${productionPlan.stats.reactionCues}, ` +
          `silences=${productionPlan.stats.silenceCues}, cooldownSuppressions=${productionPlan.stats.cooldownSuppressions}, ` +
          `seed=${productionPlan.seed})`
      );
    }

    const targetSampleRateEarly = Number(process.env.AUDIO_TARGET_SAMPLE_RATE) || 44100;
    let assetSet: SoundDesignAssetSet = emptyAssetSet();
    if (style !== "clean") {
      assetSet = await loadSoundDesignAssetSet({
        style,
        config: sdConfig,
        frozenProfile,
        highlightAssetIds: highlightPlacements.map((h) => h.assetId),
        extraAssetIds: productionPlan
          ? productionPlan.cues.map((c) => c.assetId).filter((id): id is string => !!id)
          : undefined,
        tempDir,
        storageProvider,
        ffmpegPath,
        ffprobePath,
        sampleRate: targetSampleRateEarly,
        warnings: soundWarnings,
      });
      console.log(
        `[Stitcher] Sound design: style=${style} density=${sfxDensity} ` +
          `intro=${assetSet.intro?.name || "-"} outro=${assetSet.outro?.name || "-"} bed=${assetSet.bed?.name || "-"} ` +
          `stingers=${assetSet.stingers.length} sfxCategories=${[...assetSet.sfxByCategory.keys()].join("/") || "-"} ` +
          `highlights=${assetSet.highlights.size}/${highlightPlacements.length}`
      );
      for (const w of soundWarnings) console.warn(`[Stitcher] ${w}`);
    } else {
      console.log("[Stitcher] Sound design: style=clean (dialogue-only render).");
    }

    // 4. Intro: configured theme asset wins; AUDIO_INTRO_URL env is the
    // legacy fallback. `includeIntro` still gates both.
    let introFile: string | null = null;
    if (includeIntro && !assetSet.intro && !frozenProfile) {
      // Env fallback is LEGACY-ONLY: a snapshot-v2 episode may never use an
      // intro its configuration did not capture. The URL is never logged.
      const introUrl = process.env.AUDIO_INTRO_URL;
      if (introUrl) {
        introFile = path.join(tempDir, "intro-raw.mp3");
        console.log("[Stitcher] Loading legacy env intro clip (AUDIO_INTRO_URL).");
        const res = await storageProvider.getObject({ url: introUrl });
        fs.writeFileSync(introFile, res.body);
      } else {
        console.warn("[Stitcher] includeIntro is true but no theme asset or AUDIO_INTRO_URL is configured. Skipping intro.");
      }
    }

    // 5. Outro: same precedence as the intro.
    let outroFile: string | null = null;
    if (includeOutro && !assetSet.outro && !frozenProfile) {
      // Env fallback is LEGACY-ONLY (see intro note). URL never logged.
      const outroUrl = process.env.AUDIO_OUTRO_URL;
      if (outroUrl) {
        outroFile = path.join(tempDir, "outro-raw.mp3");
        console.log("[Stitcher] Loading legacy env outro clip (AUDIO_OUTRO_URL).");
        const res = await storageProvider.getObject({ url: outroUrl });
        fs.writeFileSync(outroFile, res.body);
      } else {
        console.warn("[Stitcher] includeOutro is true but no theme asset or AUDIO_OUTRO_URL is configured. Skipping outro.");
      }
    }

    // 6. Download Dialogue Segments
    const downloadedLines: { filePath: string; line: any }[] = [];
    for (const segment of validatedSegments) {
      const line = allLines.find((l) => l.lineIndex === segment.lineIndex);
      const destFile = path.join(tempDir, `line-${segment.lineIndex}-raw.mp3`);
      console.log(`[Stitcher] Loading dialogue segment for line #${segment.lineIndex}.`);
      const res = await storageProvider.getObject({ url: segment.audioUrl! });
      fs.writeFileSync(destFile, res.body);

      if (!fs.existsSync(destFile) || fs.statSync(destFile).size === 0) {
        throw new Error(`Downloaded segment for line #${segment.lineIndex} is empty or missing.`);
      }

      downloadedLines.push({ filePath: destFile, line });
    }

    // 7. Standardize every clip to WAV at matched speech loudness.
    // WAV intermediates avoid MP3 encoder padding (the tiny clicks/gaps that
    // plague MP3 concat), and per-clip loudnorm means neither host is louder
    // than the other going into the mix.
    const targetSampleRate = Number(process.env.AUDIO_TARGET_SAMPLE_RATE) || 44100;
    const targetBitrate = process.env.AUDIO_TARGET_BITRATE || "192k";

    const plannedLines: PlannedLine[] = [];
    for (let i = 0; i < downloadedLines.length; i++) {
      const curr = downloadedLines[i];
      const prev = i > 0 ? downloadedLines[i - 1] : null;

      const wavPath = path.join(tempDir, `std-line-${curr.line.lineIndex}.wav`);
      await standardizeClipToWav(ffmpegPath, curr.filePath, wavPath, {
        sampleRate: targetSampleRate,
      });
      const durationMs = await getFileDurationMs(ffprobePath, wavPath);

      // Detect script-segment boundaries for longer topic-change beats
      let segmentBreak: PlannedLine["segmentBreak"] = "none";
      if (prev) {
        const currSegmentIndex = segments.findIndex((s) => s.lines.some((l: any) => l.lineIndex === curr.line.lineIndex));
        const prevSegmentIndex = segments.findIndex((s) => s.lines.some((l: any) => l.lineIndex === prev.line.lineIndex));
        if (currSegmentIndex !== prevSegmentIndex) {
          segmentBreak = segments[currSegmentIndex]?.type === "topic" ? "topic" : "segment";
        }
      }

      plannedLines.push({
        filePath: wavPath,
        durationMs,
        lineIndex: curr.line.lineIndex,
        hostSlot: Math.max(0, speakers.seatOf(curr.line.speakerHostId)),
        pauseBefore: curr.line.pauseBefore,
        isInterruption: curr.line.isInterruption === true,
        segmentBreak,
      });
    }

    // 7b. Edge-silence for interruptions: an overlap that only eats the TTS
    // clips' lead-in/tail padding sounds sequential, not like a cut-in. The
    // timeline planner widens each interruption's bite by the measured
    // padding, so only the pairs around an interruption need measuring.
    for (let i = 1; i < plannedLines.length; i++) {
      if (!plannedLines[i].isInterruption) continue;
      const [prevEdge, currEdge] = await Promise.all([
        measureEdgeSilenceMs(ffmpegPath, plannedLines[i - 1].filePath),
        measureEdgeSilenceMs(ffmpegPath, plannedLines[i].filePath),
      ]);
      plannedLines[i - 1].tailSilenceMs = prevEdge.tailMs;
      plannedLines[i].leadSilenceMs = currEdge.leadMs;
      console.log(
        `[Stitcher] Interruption at line ${plannedLines[i].lineIndex}: widening overlap past ` +
          `${prevEdge.tailMs}ms tail + ${currEdge.leadMs}ms lead of clip padding.`
      );
    }

    // 8. Plan the conversational timeline (variable gaps, jitter, overlaps
    // on interruptions), then splice intro/outro music in with crossfades.
    const musicCrossfadeMs = Number(process.env.AUDIO_MUSIC_CROSSFADE_MS) || 900;

    // Resolve the intro source: standardized theme asset, or env-URL clip.
    let introStd: { filePath: string; durationMs: number } | null = null;
    if (assetSet.intro && includeIntro) {
      introStd = { filePath: assetSet.intro.filePath, durationMs: assetSet.intro.durationMs };
    } else if (introFile) {
      const stdIntro = path.join(tempDir, "std-intro.wav");
      await standardizeClipToWav(ffmpegPath, introFile, stdIntro, {
        sampleRate: targetSampleRate,
        targetLufs: -17,
      });
      introStd = { filePath: stdIntro, durationMs: await getFileDurationMs(ffprobePath, stdIntro) };
    }

    let introClip: TimelineClip | null = null;
    let dialogueStartMs = 0;
    if (plannerEnabled && productionPlan) {
      // Planner path: the plan's intro cue (or its absence) is the call.
      const resolved = resolveIntroFromPlan({
        plan: productionPlan,
        assetsById: assetSet.byId,
        envIntro: introStd,
        musicCrossfadeMs,
        warnings: soundWarnings,
      });
      introClip = resolved.introClip;
      dialogueStartMs = resolved.dialogueStartMs;
    } else if (introStd) {
      introClip = {
        filePath: introStd.filePath,
        startMs: 0,
        durationMs: introStd.durationMs,
        kind: "music",
        pan: 0,
        fadeInMs: 20,
        fadeOutMs: musicCrossfadeMs,
        gainDb: -2,
      };
      // First line begins while the intro's tail is still fading — a
      // crossfade, not a hard cut into silence.
      dialogueStartMs = Math.max(0, introStd.durationMs - musicCrossfadeMs);
    }

    // Stinger-aware gaps: a transition needs room between segments, but ONLY
    // at the break where a stinger actually plays, and only as much room as
    // THAT stinger needs. (v10 postmortem: widening every break to fit the
    // longest stinger cued anywhere in the episode turned all nine topic/
    // segment turns into 10-17s of dead air once the Epidemic crate's 13.75s
    // risers entered the pool.)
    const stingerDurations =
      plannerEnabled && productionPlan
        ? plannedStingerDurations(productionPlan, assetSet.byId)
        : assetSet.stingers.map((s) => s.durationMs);
    // Per-break widening, capped: each break gets room for exactly the
    // stinger that lands there; longer risers start under the outgoing
    // line's tail instead of stretching the gap into a voice-free interlude
    // (see DEFAULT_STINGER_ROOM_CAP_MS).
    const stingerRoomCapMs = Math.max(
      0,
      Number(process.env.AUDIO_STINGER_MAX_ROOM_MS) || DEFAULT_STINGER_ROOM_CAP_MS
    );
    const planOpts: Parameters<typeof planConversationTimeline>[1] = { startAtMs: dialogueStartMs };
    // (plannerEnabled already implies style !== "clean".)
    if (plannerEnabled && productionPlan) {
      applyPlannedStingerRoom(plannedLines, productionPlan, assetSet.byId, stingerRoomCapMs);
    } else {
      applyRotationStingerRoom(plannedLines, stingerDurations, style, stingerRoomCapMs);
    }

    const dialogueClips = planConversationTimeline(plannedLines, planOpts);

    // Outro source: standardized theme asset, or env-URL clip. Resolved
    // before placement so both paths (plan execution / legacy) can use it.
    let outroStd: { filePath: string; durationMs: number } | null = null;
    if (assetSet.outro && includeOutro) {
      outroStd = { filePath: assetSet.outro.filePath, durationMs: assetSet.outro.durationMs };
    } else if (outroFile) {
      const stdOutro = path.join(tempDir, "std-outro.wav");
      await standardizeClipToWav(ffmpegPath, outroFile, stdOutro, {
        sampleRate: targetSampleRate,
        targetLufs: -17,
      });
      outroStd = { filePath: stdOutro, durationMs: await getFileDurationMs(ffprobePath, stdOutro) };
    }

    const lineByIndex = new Map<number, any>(allLines.map((l) => [l.lineIndex, l]));
    let highlightClips: TimelineClip[] = [];
    let highlightSummary: SoundDesignSummary["highlights"] = [];
    let stingerClips: TimelineClip[] = [];
    let reactionClips: TimelineClip[] = [];
    let reactionSummary: SoundDesignSummary["reactions"] = [];
    let outroClip: TimelineClip | null = null;
    let bedAssetForMix: LoadedAsset | null = null;
    let plannerStingerSummary: SoundDesignSummary["stingers"] = undefined;
    let plannerSilenceSummary: SoundDesignSummary["silences"] = undefined;

    if (plannerEnabled && productionPlan) {
      // 8-planner. The renderer EXECUTES the cue sheet — every placement
      // below traces back to a plan cue with a reason. No decisions here.
      const planResult = executePlanOnTimeline({
        plan: productionPlan,
        plannedLines,
        dialogueClips,
        assetsById: assetSet.byId,
        envOutro: outroStd,
        musicCrossfadeMs,
        dialogueStartMs,
        warnings: soundWarnings,
      });
      highlightClips = planResult.highlightClips;
      highlightSummary = planResult.highlightSummary;
      stingerClips = planResult.stingerClips;
      reactionClips = planResult.reactionClips;
      reactionSummary = planResult.reactionSummary;
      outroClip = planResult.outroClip;
      bedAssetForMix = style === "full" ? planResult.bedAsset : null;
      plannerStingerSummary = planResult.stingerSummary;
      plannerSilenceSummary = planResult.silenceSummary;
      for (const s of planResult.silenceSummary) {
        console.log(`[Stitcher][Plan] silence @line ${s.lineIndex}: ${s.reason}`);
      }
    } else {
    // 8b. Rights-gated game highlights: insert each cleared clip right after
    // its script beat, pushing everything later down the timeline.
    const sortedHighlights = [...highlightPlacements].sort((a, b) => a.lineIndex - b.lineIndex);
    for (const hl of sortedHighlights) {
      const asset = assetSet.highlights.get(hl.assetId);
      const lineIdx = plannedLines.findIndex((l) => l.lineIndex === hl.lineIndex);
      if (!asset || lineIdx === -1) {
        soundWarnings.push(
          `Highlight at line ${hl.lineIndex} skipped: ${!asset ? "asset unavailable or rights not confirmed" : "line not found"}.`
        );
        continue;
      }
      const lineClip = dialogueClips[lineIdx];
      const afterEndMs = lineClip.startMs + lineClip.durationMs;
      const atMs = shiftTimelineForInsert([...dialogueClips, ...highlightClips], afterEndMs, asset.durationMs);
      highlightClips.push({
        filePath: asset.filePath,
        startMs: atMs,
        durationMs: asset.durationMs,
        kind: "music",
        pan: 0,
        fadeInMs: 120,
        fadeOutMs: 250,
        gainDb: -2,
      });
      highlightSummary.push({ lineIndex: hl.lineIndex, asset: asset.name });
    }

    // 8c. Stingers punctuate segment/topic changes ("light" = topic breaks
    // only, "full" = both), rotating through the configured set.
    const stingerSlots = plannedLines
      .map((l, i) => ({ line: l, clip: dialogueClips[i] }))
      .filter(({ line }) => line.segmentBreak === "segment" || line.segmentBreak === "topic")
      .map(({ line, clip }) => ({
        lineIndex: line.lineIndex,
        breakKind: line.segmentBreak as "segment" | "topic",
        lineStartMs: clip.startMs,
      }));
    const stingerPlacements = planStingers(stingerSlots, style, stingerDurations);
    // Stingers longer than their break's reserved room start under the
    // previous line's tail — ease those in like the planner path does.
    const prevClipEndByLine = new Map<number, number>();
    plannedLines.forEach((l, i) => {
      if (i > 0) {
        prevClipEndByLine.set(
          l.lineIndex,
          dialogueClips[i - 1].startMs + dialogueClips[i - 1].durationMs
        );
      }
    });
    stingerClips = stingerPlacements.map((p) => {
      const asset = assetSet.stingers[p.stingerIndex];
      const prevEndMs = prevClipEndByLine.get(p.lineIndex) ?? 0;
      const overlapMs = Math.max(0, prevEndMs - p.atMs);
      return {
        filePath: asset.filePath,
        startMs: p.atMs,
        durationMs: asset.durationMs,
        kind: "sfx",
        pan: 0,
        fadeInMs: overlapMs > 0 ? Math.min(1200, Math.max(15, overlapMs)) : 15,
        fadeOutMs: 90,
        gainDb: p.gainDb,
      };
    });

    // 8d. Reaction SFX on emotional beats (full style only) — placement is
    // driven by the script's own tone/energy metadata, rate-limited by the
    // configured density so reactions land on peaks, never wallpaper.
    if (style === "full") {
      const sfxContexts: SfxLineContext[] = plannedLines.map((l, i) => {
        const scriptLine = lineByIndex.get(l.lineIndex) || {};
        return {
          lineIndex: l.lineIndex,
          tone: scriptLine.tone,
          energy: scriptLine.energy,
          startMs: dialogueClips[i].startMs,
          durationMs: dialogueClips[i].durationMs,
        };
      });
      const availableCategories = new Set<SfxCategory>([...assetSet.sfxByCategory.keys()]);
      const reactions = planReactionSfx(sfxContexts, sfxDensity, { availableCategories });
      for (const placement of reactions) {
        const asset = pickSfxAsset(assetSet, placement);
        if (!asset) continue;
        reactionClips.push({
          filePath: asset.filePath,
          startMs: placement.atMs,
          durationMs: asset.durationMs,
          kind: "sfx",
          pan: 0,
          fadeInMs: 25,
          fadeOutMs: 150,
          gainDb: placement.gainDb,
        });
        reactionSummary.push({
          lineIndex: placement.lineIndex,
          asset: asset.name,
          reason: placement.reason,
          atMs: placement.atMs,
        });
      }
    }

    const dialogueEndMs = dialogueClips.length
      ? Math.max(...[...dialogueClips, ...highlightClips].map((c) => c.startMs + c.durationMs))
      : dialogueStartMs;

    if (outroStd) {
      outroClip = {
        filePath: outroStd.filePath,
        startMs: Math.max(0, dialogueEndMs - Math.round(musicCrossfadeMs / 2)),
        durationMs: outroStd.durationMs,
        kind: "music",
        pan: 0,
        fadeInMs: musicCrossfadeMs,
        fadeOutMs: 400,
        gainDb: -2,
      };
    }

    // Bed under the whole episode (full style only) — legacy uses the show
    // config's single configured bed.
    bedAssetForMix = style === "full" ? assetSet.bed : null;
    } // end legacy placement path

    // GUARD — silent sound-design collapse. A produced style (light/full) that
    // shipped with ZERO music/SFX because every asset failed to load, or the
    // asset library is empty, must never be handed out as finished "audio_ready"
    // audio. That downgrade is exactly how a music-less episode reached a
    // listener as a completed listen. Fail loudly here (before the render +
    // upload) so the real cause surfaces in the job log instead of a broken
    // "ready" link. This does NOT fire when assets loaded fine but there was
    // simply nothing to place (e.g. a short "light" script with no breaks), nor
    // for an intentional dialogue-only "clean" render.
    if (style !== "clean") {
      const mixedAnySoundDesign =
        !!introClip ||
        !!outroClip ||
        !!bedAssetForMix ||
        stingerClips.length > 0 ||
        reactionClips.length > 0 ||
        highlightClips.length > 0;
      if (!mixedAnySoundDesign) {
        const loadFailures = soundWarnings.filter((w) => /failed to load/i.test(w)).length;
        const activeAssetCount = await db.audioAsset.count({ where: { isActive: true } });
        if (loadFailures > 0 || activeAssetCount === 0) {
          throw new Error(
            `Sound design "${style}" was requested but no music or SFX reached the mix ` +
              `(${loadFailures} asset(s) failed to load; ${activeAssetCount} active asset(s) in the library). ` +
              `Refusing to ship a dialogue-only render as finished audio. Likely cause: the sound-design ` +
              `asset library is missing from storage or was never ingested. Fix the asset library ` +
              `(re-ingest and confirm the WAVs exist in storage), then re-stitch — or set the production ` +
              `style to "clean" for an intentional dialogue-only episode.`
          );
        }
      }
    }

    // The last spoken word (dialogue + inserted highlights). The outro tail is
    // measured against this after the master is rendered (post-render bookend
    // verification below).
    const speechEndMs = dialogueClips.length
      ? Math.max(...[...dialogueClips, ...highlightClips].map((c) => c.startMs + c.durationMs))
      : dialogueStartMs;

    const clips: TimelineClip[] = [
      ...(introClip ? [introClip] : []),
      ...dialogueClips,
      ...highlightClips,
      ...stingerClips,
      ...reactionClips,
      ...(outroClip ? [outroClip] : []),
    ];

    const totalInputDurationMs = clips.length
      ? Math.max(...clips.map((c) => c.startMs + c.durationMs))
      : 0;

    // 9. Render the foreground timeline in one ffmpeg mix (shared room tone,
    // stereo seating, micro-fades, glue compression) — no concat hard cuts.
    console.log(
      `[Stitcher] Rendering ${clips.length} clips (dialogue=${dialogueClips.length}, stingers=${stingerClips.length}, ` +
        `reactions=${reactionClips.length}, highlights=${highlightClips.length}) onto conversational timeline.`
    );
    const foregroundWavPath = path.join(tempDir, "foreground-mix.wav");
    await renderTimelineToWav(ffmpegPath, clips, foregroundWavPath, {
      sampleRate: targetSampleRate,
    });

    // 9b. Music bed under the whole episode (full style): sidechain-ducked
    // by the foreground so dialogue always dominates and the bed swells
    // back in the gaps. Instrumental only, looped to length.
    let mixWavPath = foregroundWavPath;
    const bedUsed = !!bedAssetForMix;
    if (bedUsed) {
      const foregroundMs = await getFileDurationMs(ffprobePath, foregroundWavPath);
      const beddedPath = path.join(tempDir, "final-mix-bedded.wav");
      // Duck key = SPEECH (+ themes) only — never the stingers/reactions.
      // Keying off the full foreground meant every break's riser muted the bed
      // in the exact gap where the song should swell, so topic turns played as
      // whoosh-over-silence instead of music. With this key the bed rises to
      // full level between topics and still drops hard under the voices.
      const keyClips: TimelineClip[] = [
        ...(introClip ? [introClip] : []),
        ...dialogueClips,
        ...highlightClips,
        ...(outroClip ? [outroClip] : []),
      ];
      const duckKeyPath = path.join(tempDir, "duck-key.wav");
      await renderTimelineToWav(ffmpegPath, keyClips, duckKeyPath, {
        sampleRate: targetSampleRate,
      });
      console.log(`[Stitcher] Ducking music bed '${bedAssetForMix!.name}' under ${Math.round(foregroundMs / 1000)}s foreground (speech-keyed duck).`);
      await mixBedUnderForeground(ffmpegPath, foregroundWavPath, bedAssetForMix!.filePath, beddedPath, {
        sampleRate: targetSampleRate,
        totalMs: foregroundMs,
        keyWavPath: duckKeyPath,
      });
      mixWavPath = beddedPath;
    }

    // 10. Master: two-pass linear loudnorm to podcast loudness.
    const finalOutputPath = path.join(tempDir, "final.mp3");
    if (normalizeAudio) {
      console.log(`[Stitcher] Mastering to ${targetLufs} LUFS (two-pass loudnorm).`);
      await masterToMp3(ffmpegPath, mixWavPath, finalOutputPath, {
        targetLufs,
        bitrate: targetBitrate,
      });
    } else {
      await runFfmpeg(ffmpegPath, [
        "-y",
        "-i", mixWavPath,
        "-c:a", "libmp3lame",
        "-b:a", targetBitrate,
        finalOutputPath,
      ]);
    }

    // 10b. Automated human-ness QA on the finished master.
    let qaReport: AudioQaReport | null = null;
    try {
      qaReport = await analyzeEpisodeAudio(ffmpegPath, finalOutputPath, {
        targetLufs,
        // Grade pacing from the pause plan we actually authored — the bed masks
        // it in the mastered mix (see scorePauseVariety).
        scriptedPauses: allLines.map((l) => l.pauseBefore),
      });
      for (const c of qaReport.checks) {
        console.log(`[Stitcher][QA] ${c.status.toUpperCase()} — ${c.name}: ${c.value}`);
      }
      if (!qaReport.passed && process.env.AUDIO_QA_STRICT === "true") {
        const failed = qaReport.checks
          .filter((c) => c.status === "fail")
          .map((c) => `${c.name} (${c.value})`)
          .join("; ");
        throw new Error(`Audio QA failed (AUDIO_QA_STRICT=true): ${failed}`);
      }
    } catch (qaErr: unknown) {
      if (process.env.AUDIO_QA_STRICT === "true") throw qaErr;
      const msg = qaErr instanceof Error ? qaErr.message : String(qaErr);
      console.warn(`[Stitcher] Audio QA analysis skipped/failed: ${msg}`);
    }

    if (!fs.existsSync(finalOutputPath) || fs.statSync(finalOutputPath).size === 0) {
      throw new Error("Stitched output file is empty or missing.");
    }

    const finalFileSizeBytes = fs.statSync(finalOutputPath).size;
    const finalDurationSeconds = (await getFileDurationMs(ffprobePath, finalOutputPath)) / 1000;

    // 10c. POST-RENDER BOOKEND VERIFICATION. A cue row is not proof: verify the
    // actual mastered waveform. For a non-clean episode, an intro/outro that the
    // resolved configuration REQUIRES must be resolved, planned, loaded,
    // executed, AND measurably audible. A required bookend that vanished at ANY
    // stage — profile resolution, the theme genre gate, plan creation, asset
    // loading, timeline execution, or mastering (silent/clipped) — FAILS the
    // render with an explicit, stage-specific safe reason. The throw lands in the
    // catch below (before upload / success-close / usage recording), so the prior
    // master stays active, no failed output is promoted, and no failed cue is
    // recorded as usage. A disabled/clean/profile-has-none bookend is skipped.
    const bookendRequirement = (kind: BookendKind) =>
      resolveBookendRequirement({
        kind,
        clean: style === "clean",
        enabled: kind === "intro" ? includeIntro : includeOutro,
        hasFrozenProfile: !!frozenProfile,
        // v4 explicit frozen intent (null for v2/v3 — compatibility path).
        frozenIntent: frozenProfile ? frozenBookendEnabled(frozenProfile, kind) : null,
        frozenRefAssetId: (kind === "intro" ? frozenProfile?.intro : frozenProfile?.outro)?.assetId ?? null,
        frozenExcludedReason: frozenProfile?.excluded.find((e) => e.role === kind)?.reason ?? null,
        legacyConfiguredAssetId: frozenProfile
          ? null
          : (kind === "intro" ? sdConfig?.themeIntroAssetId : sdConfig?.themeOutroAssetId) ?? null,
        legacyEnvConfigured:
          !frozenProfile && !!(kind === "intro" ? process.env.AUDIO_INTRO_URL : process.env.AUDIO_OUTRO_URL),
      });
    const introReq = bookendRequirement("intro");
    const outroReq = bookendRequirement("outro");

    // Stage-specific absence reason (only used when required && not placed).
    const safeWarningFor = (name: string | null): string | null => {
      if (!name) return null;
      const w = soundWarnings.find(
        (msg) => /failed to load|hash mismatch|rights invalid|skipped/i.test(msg) && msg.includes(name)
      );
      return w ? scrubSafeText(w) : null;
    };
    const absenceReason = (kind: BookendKind, req: ReturnType<typeof resolveBookendRequirement>): string => {
      const frozenName = (kind === "intro" ? frozenProfile?.intro : frozenProfile?.outro)?.name ?? null;
      const planName = productionPlan?.cues.find((c) => c.type === kind)?.assetName ?? null;
      return describeBookendAbsence(kind, {
        req,
        planHasCue: productionPlan ? productionPlan.cues.some((c) => c.type === kind) : null,
        assetLoaded: req.assetId ? assetSet.byId.has(req.assetId) : null,
        loadWarning: safeWarningFor(frozenName ?? planName),
        themesExcluded: (productionPlan?.stats as { themesExcluded?: number } | undefined)?.themesExcluded ?? 0,
      });
    };

    let bookendResult: BookendVerification | null = null;
    try {
      bookendResult = await verifyBookends(ffmpegPath, ffprobePath, finalOutputPath, {
        introRequired: introReq.required,
        introPlaced: !!introClip,
        introDurationMs: introClip?.durationMs ?? null,
        introAbsenceReason: absenceReason("intro", introReq),
        outroRequired: outroReq.required,
        outroPlaced: !!outroClip,
        outroStartMs: outroClip?.startMs ?? null,
        outroDurationMs: outroClip?.durationMs ?? null,
        outroAbsenceReason: absenceReason("outro", outroReq),
        speechEndMs,
      });
      for (const c of bookendResult.checks) {
        console.log(`[Stitcher][Bookend] ${c.status.toUpperCase()} - ${c.name}: ${c.detail}`);
      }
    } catch (bookendErr: unknown) {
      // A measurement failure (ffmpeg hiccup) must not mask a good render, but
      // it also must not silently pass a bookend gate — record and continue;
      // the enabled-bookend gate below only fires on a definitive verification.
      const msg = bookendErr instanceof Error ? bookendErr.message : String(bookendErr);
      console.warn(`[Stitcher][Bookend] verification could not run: ${msg}`);
    }
    if (bookendResult && !bookendResult.ok) {
      throw new Error(
        `Post-render bookend verification failed: ${bookendResult.failures.join(" ")}`
      );
    }

    // 11. Upload final MP3
    const episodeSlug = episode.slug || "";
    const versionStr = script.version.toString();
    const storageKey = episodeSlug
      ? `episodes/${episode.id}/scripts/${scriptId}/final/take-machine-${episodeSlug}-v${versionStr}.mp3`
      : `episodes/${episode.id}/scripts/${scriptId}/final/final.mp3`;

    console.log(`[Stitcher] Uploading final stitched audio for episode ${episode.id}.`);
    const uploadResult = await storageProvider.putObject({
      key: storageKey,
      body: fs.readFileSync(finalOutputPath),
      contentType: "audio/mp3",
    });

    // 12. Update Database Records inside a transaction. The style/density
    // used for this render are pinned on the episode so re-runs (and the
    // console) stay consistent with what actually shipped.
    // Preserve a produced episode's later status across a re-mix: adding music
    // to a finished (or published) episode must not regress it to audio_ready
    // and out of its content/publish stage. A fresh stitch (from
    // audio_segments_ready / fact_checked) still lands on audio_ready.
    const finalEpisodeStatus = PRODUCED_OR_LATER.has(previousStatus)
      ? previousStatus
      : "audio_ready";

    await db.$transaction([
      db.episode.update({
        where: { id: episode.id },
        data: {
          status: finalEpisodeStatus,
          audioUrl: uploadResult.url,
          durationSeconds: Math.round(finalDurationSeconds),
          soundDesign: {
            ...episodeSound,
            style,
            sfxDensity,
          } as any,
        },
      }),
    ]);

    // What the sound-design stage actually mixed in — the proof layer (hoisted
    // so both the job log and the render diagnostics reuse one source of truth).
    const soundDesignSummary: SoundDesignSummary = {
      style,
      sfxDensity,
      introAsset: introClip ? (assetSet.intro?.name ?? "env intro clip") : null,
      outroAsset: outroClip ? (assetSet.outro?.name ?? "env outro clip") : null,
      bedAsset: bedUsed ? bedAssetForMix!.name : null,
      bedDucking: bedUsed,
      stingerCount: stingerClips.length,
      reactionCount: reactionClips.length,
      reactions: reactionSummary,
      highlightCount: highlightClips.length,
      highlights: highlightSummary,
      ...(plannerEnabled && productionPlan
        ? {
            planner: true,
            plannerVersion: productionPlan.plannerVersion,
            stingers: plannerStingerSummary,
            silences: plannerSilenceSummary,
          }
        : {}),
    };

    // Safe, durable render diagnostics for the render record (and job log).
    const renderDiagnostics = buildRenderDiagnostics({
      renderId: renderRecord.id,
      renderVersion: renderRecord.renderVersion,
      renderMode,
      snapshotVersion: (episode.configurationSnapshot as { version?: number } | null)?.version ?? null,
      soundProfileMode: frozenProfile?.mode ?? null,
      plannerSeed: productionPlan?.seed ?? null,
      plannerVersion: productionPlan?.plannerVersion ?? null,
      style,
      sfxDensity,
      targetLoudnessLufs: frozenProfile?.targetLoudnessLufs ?? null,
      cooldownScope:
        frozenProfile?.cooldownScope === "owner"
          ? "owner"
          : episode.podcastId
            ? "podcast"
            : episode.ownerId
              ? "owner"
              : "system",
      frozenProfile,
      productionPlan,
      summary: soundDesignSummary,
      bookend: bookendResult,
      speechEndMs,
      masterDurationMs: Math.round(finalDurationSeconds * 1000),
      skippedWarnings: soundWarnings,
    });

    // 13. Write Success JobLog
    const successOutput = {
      episodeId: episode.id,
      scriptId,
      finalStatus: "completed",
      finalAudioUrl: uploadResult.url,
      durationSeconds: Math.round(finalDurationSeconds),
      lineCount,
      audioSegmentCount: validatedSegments.length,
      missingSegmentCount: 0,
      failedSegmentCount: 0,
      duplicateSegmentCount: 0,
      totalInputDurationMs,
      finalFileSizeBytes,
      ffmpegCommandSummary:
        `${ffmpegPath} timeline-mix (adelay+amix, room tone, stereo seating)` +
        (bedUsed ? " + sidechain-ducked bed" : "") +
        " + two-pass loudnorm",
      storageKey,
      audioQa: qaReport,
      // Combined episode score: script rubric (70%) + audio human-ness (30%).
      episodeScore: computeEpisodeScore((script.content as any)?.quality, qaReport),
      // What the sound-design stage actually mixed in — the proof layer.
      soundDesign: soundDesignSummary,
      // Post-render bookend verification of the actual waveform.
      bookend: bookendResult,
      // Safe per-render cue-sheet diagnostics (also persisted on the render record).
      renderDiagnostics,
      // The full cue sheet this render executed — reproducible from inputs.
      ...(plannerEnabled && productionPlan ? { productionPlan } : {}),
      reasons: ["Final audio stitched and uploaded successfully.", ...soundWarnings],
    };

    await db.jobLog.update({
      where: { id: jobLog.id },
      data: {
        status: "completed",
        output: successOutput as any,
      },
    });

    // Close the immutable render-version record: what mode ran, which plan
    // was executed, and where the master landed.
    try {
      await db.episodeAudioRender.update({
        where: { id: renderRecord.id },
        data: {
          status: "succeeded",
          completedAt: new Date(),
          plannerSeed: productionPlan?.seed ?? null,
          productionStyle: style,
          sfxDensity,
          plan: productionPlan ? (productionPlan as unknown as object) : undefined,
          diagnostics: renderDiagnostics as unknown as object,
          outputAudioUrl: uploadResult.url,
        },
      });
    } catch (renderErr: unknown) {
      console.warn(`[Stitcher] Failed to close the render record: ${renderErr instanceof Error ? renderErr.message : String(renderErr)}`);
    }

    // Feed the cooldown ledger AFTER the render shipped — a failed render
    // must never cool assets down. Best-effort: a ledger hiccup is a warning,
    // not a failed episode. Usage rows carry the render id, owner/podcast
    // scope, and the frozen asset facts (kind/scope/hash/gain/fades).
    if (plannerEnabled && productionPlan) {
      try {
        const assetFacts = new Map<string, { kind: string; scope: string; contentHash: string | null; gainDb: number | null; fadeInMs: number | null; fadeOutMs: number | null }>();
        if (frozenProfile) {
          for (const ref of [frozenProfile.intro, frozenProfile.outro, frozenProfile.bed, ...frozenProfile.stingers, ...frozenProfile.reactions]) {
            if (ref) assetFacts.set(ref.assetId, { kind: ref.kind, scope: ref.scope, contentHash: ref.contentHash, gainDb: ref.gainDb, fadeInMs: ref.fadeInMs, fadeOutMs: ref.fadeOutMs });
          }
        }
        await recordPlanUsage(productionPlan, {
          renderId: renderRecord.id,
          ownerId: episode.ownerId ?? null,
          podcastId: episode.podcastId ?? null,
          selectionSource:
            renderMode === "reproduce"
              ? "historical_reproduction"
              : frozenProfile
                ? frozenProfile.mode === "custom"
                  ? "podcast_assignment"
                  : "system_default"
                : "production_planner",
          assetFacts,
        });
      } catch (usageErr: unknown) {
        const msg = usageErr instanceof Error ? usageErr.message : String(usageErr);
        console.warn(`[Stitcher] Failed to record sound-cue usage: ${msg}`);
      }
    }

    // Clean up temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      console.warn(`[Stitcher] Failed to remove temp directory ${tempDir}:`, e);
    }

    return successOutput;
  } catch (err: any) {
    console.error("[Stitcher] Stitching failed:", err.message);

    // Close the render record as failed with a SAFE reason (no URLs/keys).
    // The episode's previous final audio is untouched — a failed remix never
    // costs a published master.
    if (renderRecordId) {
      try {
        const safeFailure = scrubSafeText(String(err?.message || "unknown")).slice(0, 500);
        await db.episodeAudioRender.update({
          where: { id: renderRecordId },
          data: {
            status: "failed",
            completedAt: new Date(),
            failureReason: safeFailure,
            // Minimal safe diagnostics on the failure path too: a failed render
            // still explains itself (e.g. a bookend gate rejection) without a
            // successful cue sheet to attach.
            diagnostics: {
              version: RENDER_DIAGNOSTICS_VERSION,
              status: "failed",
              failureReason: safeFailure,
            } as unknown as object,
          },
        });
      } catch { /* best effort */ }
    }

    // Restore previous status of the episode
    if (scriptRecord?.episode) {
      try {
        await db.episode.update({
          where: { id: scriptRecord.episode.id },
          data: { status: previousStatus },
        });
      } catch (e) {
        console.error("[Stitcher] Failed to restore episode status:", e);
      }
    }

    // Write failed JobLog
    await db.jobLog.update({
      where: { id: jobLog.id },
      data: {
        status: "failed",
        error: err.message || "Unknown stitching error",
        output: {
          scriptId,
          finalStatus: "failed",
          reasons: [err.message || "Unknown stitching error"],
        } as any,
      },
    });

    throw err;
  }
}
