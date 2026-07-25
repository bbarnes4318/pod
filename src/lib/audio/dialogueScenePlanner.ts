// Deterministic dialogue scene planner.
//
// Converts the APPROVED script's flat line list into coherent TTS scenes — the
// unit a native dialogue engine (ElevenLabs Text to Dialogue, Fish S2-Pro
// multi-speaker) renders in ONE request so the model performs the whole
// conversational movement instead of isolated sentences.
//
// PURE + deterministic: same lines + same budget → same scenes, ids, and
// fingerprints. No LLM, no env reads, no Date/random. The provider budget
// comes from the verified capability matrix (capabilities.ts), never from a
// hardcoded universal constant.
//
// Boundary philosophy (tested in testDialogueScenePlanner):
//   PREFER breaks at:  segment/topic transitions (also where stingers land),
//                      intro/outro edges, major emotional direction changes,
//                      provider budget edges.
//   NEVER break:       immediately before an interruption or a reaction that
//                      depends on the previous line (em-dash hand-off),
//                      between a setup line and its payoff,
//                      mid-sentence (we only ever cut BETWEEN whole lines).

import crypto from "crypto";
import type { DialogueSceneType } from "@/lib/providers/tts/sceneTypes";

export const SCENE_PLANNER_VERSION = 1;

/** The subset of a script line the planner needs. `text` is APPROVED text. */
export interface PlannerLine {
  lineIndex: number;
  speakerHostId: string;
  speakerName: string;
  text: string;
  tone?: string | null;
  energy?: "low" | "medium" | "high" | null;
  isInterruption?: boolean;
  pauseBefore?: "none" | "beat" | "breath" | "long";
  /** Boundary ENTERING this line: does a new script segment start here? */
  segmentBoundary: "none" | "segment" | "topic";
  /** Script segment type this line belongs to ("intro", "topic", "outro", ...). */
  segmentType?: string | null;
}

export interface PlannedScene {
  sceneId: string;
  sceneIndex: number;
  sceneType: DialogueSceneType;
  firstLineIndex: number;
  lastLineIndex: number;
  lineIndexes: number[];
  lines: PlannerLine[];
  /** Distinct speakers in speaking order of first appearance. */
  speakerHostIds: string[];
  characterCount: number;
  /** Why this scene STARTS where it does. */
  openedBy: "episode_start" | "segment" | "topic" | "budget" | "emotional_shift";
  /** One line larger than the whole budget — the service must render this
   *  scene through the per-line fallback, honestly recorded. */
  oversized: boolean;
}

export interface ScenePlanInput {
  scriptId: string;
  formatId: string;
  lines: PlannerLine[];
  /** Provider budget (characters across a scene's line texts). */
  maxCharacters: number;
  /** Provider cap on distinct voices per request. */
  maxSpeakers: number;
}

export interface ScenePlan {
  plannerVersion: number;
  scriptId: string;
  formatId: string;
  scenes: PlannedScene[];
}

const HOT_TONES = new Set(["heated", "excited", "incredulous"]);
const CALM_TONES = new Set(["analytical", "reflective", "conceding", "setup", "transition"]);

/** Emotional direction change big enough to justify a cut (only honored once
 *  a scene already has real length — see MIN_TURNS_BEFORE_EMOTIONAL_CUT). */
function isEmotionalShift(prev: PlannerLine, curr: PlannerLine): boolean {
  const prevHot = HOT_TONES.has((prev.tone || "").toLowerCase()) || prev.energy === "high";
  const currCalm = CALM_TONES.has((curr.tone || "").toLowerCase()) && curr.energy !== "high";
  return prevHot && currCalm;
}

const MIN_TURNS_BEFORE_EMOTIONAL_CUT = 6;

/** May we cut BETWEEN prev and curr at all? (The "never split" rules.) */
export function isSplittableBoundary(prev: PlannerLine, curr: PlannerLine): boolean {
  // An interruption depends on the line it cuts off — never separate them.
  if (curr.isInterruption) return false;
  // Em-dash hand-off: the previous line ends mid-sentence for the next line
  // to complete/react to (the script engine's interruption convention).
  if (/[—-]\s*$/.test((prev.text || "").trim())) return false;
  // A setup and its immediate payoff stay together.
  if ((prev.tone || "").toLowerCase() === "setup") return false;
  return true;
}

function lineChars(l: PlannerLine): number {
  return (l.text || "").length;
}

/** Deterministic scene type from format + position + scene content. */
export function classifySceneType(opts: {
  formatId: string;
  isFirstScene: boolean;
  isLastScene: boolean;
  lines: PlannerLine[];
}): DialogueSceneType {
  const { formatId, isFirstScene, isLastScene, lines } = opts;
  if (isFirstScene) return "cold_open";
  if (isLastScene) return "closing";

  // Format-driven defaults for the middle of the show.
  switch (formatId) {
    case "news_roundup":
      return "news_block";
    case "host_and_expert":
      return "host_expert_exchange";
    case "interview":
      return "interview_exchange";
    case "documentary":
      return "documentary_narration";
    case "rapid_fire":
      return "rapid_fire";
  }

  // Debate-ish formats: read the emotional arc of the scene itself.
  const hotCount = lines.filter(
    (l) => HOT_TONES.has((l.tone || "").toLowerCase()) || l.energy === "high"
  ).length;
  const hasConcession = lines.some((l) => (l.tone || "").toLowerCase() === "conceding");
  if (hotCount >= 2 && hasConcession) return "argument_resolution";
  if (hotCount >= 2) return "argument_escalation";
  // A short bridge scene that only moves the show along.
  if (lines.length <= 2 && lines.every((l) => ["transition", "setup"].includes((l.tone || "").toLowerCase()))) {
    return "transition";
  }
  return "conversation";
}

/**
 * Plan scenes. Every input line lands in exactly one scene, order preserved.
 */
export function planDialogueScenes(input: ScenePlanInput): ScenePlan {
  const { lines, maxCharacters, maxSpeakers } = input;
  const scenes: PlannedScene[] = [];
  if (lines.length === 0) {
    return { plannerVersion: SCENE_PLANNER_VERSION, scriptId: input.scriptId, formatId: input.formatId, scenes };
  }

  let current: PlannerLine[] = [];
  let currentChars = 0;
  let currentSpeakers = new Set<string>();
  let openedBy: PlannedScene["openedBy"] = "episode_start";
  let nextOpenedBy: PlannedScene["openedBy"] = "episode_start";

  const flush = (oversized = false) => {
    if (current.length === 0) return;
    const speakerOrder: string[] = [];
    for (const l of current) if (!speakerOrder.includes(l.speakerHostId)) speakerOrder.push(l.speakerHostId);
    scenes.push({
      sceneId: "", // assigned after typing (needs sceneIndex)
      sceneIndex: scenes.length,
      sceneType: "conversation", // assigned below
      firstLineIndex: current[0].lineIndex,
      lastLineIndex: current[current.length - 1].lineIndex,
      lineIndexes: current.map((l) => l.lineIndex),
      lines: current,
      speakerHostIds: speakerOrder,
      characterCount: currentChars,
      openedBy,
      oversized,
    });
    current = [];
    currentChars = 0;
    currentSpeakers = new Set();
    openedBy = nextOpenedBy;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = i > 0 ? lines[i - 1] : null;
    const chars = lineChars(line);

    // A single line bigger than the whole budget: it becomes its own
    // oversized scene (rendered via line fallback — never silently truncated).
    if (chars > maxCharacters) {
      nextOpenedBy = "budget";
      flush();
      current = [line];
      currentChars = chars;
      currentSpeakers = new Set([line.speakerHostId]);
      nextOpenedBy = "budget";
      flush(true);
      continue;
    }

    if (prev && current.length > 0) {
      const splittable = isSplittableBoundary(prev, line);
      const structural = line.segmentBoundary !== "none";
      const overBudget = currentChars + chars > maxCharacters;
      const overSpeakers = !currentSpeakers.has(line.speakerHostId) && currentSpeakers.size >= maxSpeakers;
      const emotional =
        current.length >= MIN_TURNS_BEFORE_EMOTIONAL_CUT && isEmotionalShift(prev, line);

      // Structural boundaries cut even a small scene (a stinger lands there);
      // budget/speaker limits MUST cut; emotional shifts cut mature scenes.
      // The never-split rules veto everything except a hard budget overflow
      // (where we still cut at the nearest earlier splittable point — i.e.
      // here, since we check before adding).
      if ((structural && splittable) || (emotional && splittable)) {
        nextOpenedBy = structural ? (line.segmentBoundary === "topic" ? "topic" : "segment") : "emotional_shift";
        flush();
      } else if (overBudget || overSpeakers) {
        if (splittable) {
          nextOpenedBy = "budget";
          flush();
        } else {
          // The incoming line may not be separated from its predecessor.
          // Back up to the LAST splittable boundary inside the current scene
          // so the bonded pair travels together into the next scene.
          let cut = -1;
          for (let j = current.length - 1; j >= 1; j--) {
            if (isSplittableBoundary(current[j - 1], current[j])) { cut = j; break; }
          }
          if (cut === -1) {
            // No split point anywhere — accept the over-budget scene rather
            // than break an interruption/setup pair. (Never mid-pair cuts.)
          } else {
            const carried = current.slice(cut);
            current = current.slice(0, cut);
            currentChars = current.reduce((a, l) => a + lineChars(l), 0);
            currentSpeakers = new Set(current.map((l) => l.speakerHostId));
            nextOpenedBy = "budget";
            flush();
            current = carried;
            currentChars = carried.reduce((a, l) => a + lineChars(l), 0);
            currentSpeakers = new Set(carried.map((l) => l.speakerHostId));
          }
        }
      }
    }

    current.push(line);
    currentChars += chars;
    currentSpeakers.add(line.speakerHostId);
  }
  nextOpenedBy = "budget";
  flush();

  // Merge a trailing one-line scene into its predecessor when legal: a lone
  // closing line sounds better performed with the exchange it answers.
  for (let s = scenes.length - 1; s > 0; s--) {
    const scene = scenes[s];
    const prevScene = scenes[s - 1];
    if (
      scene.lines.length === 1 &&
      !scene.oversized &&
      !prevScene.oversized &&
      scene.openedBy === "budget" &&
      prevScene.characterCount + scene.characterCount <= maxCharacters &&
      new Set([...prevScene.speakerHostIds, ...scene.speakerHostIds]).size <= maxSpeakers
    ) {
      prevScene.lines.push(...scene.lines);
      prevScene.lineIndexes.push(...scene.lineIndexes);
      prevScene.lastLineIndex = scene.lastLineIndex;
      prevScene.characterCount += scene.characterCount;
      for (const id of scene.speakerHostIds) {
        if (!prevScene.speakerHostIds.includes(id)) prevScene.speakerHostIds.push(id);
      }
      scenes.splice(s, 1);
    }
  }

  // Final numbering, typing, ids.
  scenes.forEach((scene, idx) => {
    scene.sceneIndex = idx;
    scene.sceneType = classifySceneType({
      formatId: input.formatId,
      isFirstScene: idx === 0,
      isLastScene: idx === scenes.length - 1 && scenes.length > 1,
      lines: scene.lines,
    });
    scene.sceneId = `${input.scriptId}:${idx}:v${SCENE_PLANNER_VERSION}`;
  });

  return { plannerVersion: SCENE_PLANNER_VERSION, scriptId: input.scriptId, formatId: input.formatId, scenes };
}

/** The smallest scene containing this line (regeneration resolution). */
export function resolveSceneForLine(plan: ScenePlan, lineIndex: number): PlannedScene | null {
  return plan.scenes.find((s) => s.lineIndexes.includes(lineIndex)) ?? null;
}

/**
 * Stable request fingerprint for one scene generation. Identical approved
 * text + speaker order + provider/model/voices/settings/seed + versions →
 * identical fingerprint (idempotent reuse unless force-regenerate).
 */
export function sceneRequestFingerprint(opts: {
  scene: Pick<PlannedScene, "lineIndexes" | "lines">;
  provider: string;
  model: string;
  renderUnit: string;
  voiceMap: Record<string, string>;
  seed?: number;
  performanceSettings?: unknown;
  plannerVersion?: number;
  profileVersion?: number;
}): string {
  const payload = {
    v: 1,
    plannerVersion: opts.plannerVersion ?? SCENE_PLANNER_VERSION,
    profileVersion: opts.profileVersion ?? 0,
    provider: opts.provider,
    model: opts.model,
    renderUnit: opts.renderUnit,
    seed: opts.seed ?? null,
    voiceMap: Object.keys(opts.voiceMap).sort().map((k) => [k, opts.voiceMap[k]]),
    performanceSettings: opts.performanceSettings ?? null,
    turns: opts.scene.lines.map((l) => [l.lineIndex, l.speakerHostId, l.text]),
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Flatten Script.content segments into PlannerLines (shared by service + tests). */
export function plannerLinesFromScriptSegments(segments: Array<{ type?: string; lines?: unknown[] }>): PlannerLine[] {
  const out: PlannerLine[] = [];
  segments.forEach((seg, segIdx) => {
    const list = Array.isArray(seg?.lines) ? (seg.lines as Record<string, unknown>[]) : [];
    list.forEach((ln, li) => {
      out.push({
        lineIndex: Number(ln.lineIndex),
        speakerHostId: String(ln.speakerHostId ?? ""),
        speakerName: String(ln.speakerName ?? ""),
        text: String(ln.text ?? ""),
        tone: (ln.tone as string) ?? null,
        energy: (ln.energy as PlannerLine["energy"]) ?? null,
        isInterruption: ln.isInterruption === true,
        pauseBefore: ln.pauseBefore as PlannerLine["pauseBefore"],
        segmentBoundary: li === 0 && segIdx > 0 ? (seg?.type === "topic" ? "topic" : "segment") : "none",
        segmentType: (seg?.type as string) ?? null,
      });
    });
  });
  return out.sort((a, b) => a.lineIndex - b.lineIndex);
}
