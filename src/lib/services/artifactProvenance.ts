// Artifact provenance: does every downstream artifact still say what the
// CURRENT script says?
//
//   script text ──► fact check      (FactCheckResult.summary.checkedLines)
//        │
//        ├──► line audio            (AudioSegment.text — the words it recorded)
//        ├──► scene audio           (DialogueSceneAudio.providerMetadata.provenance.turnsHash,
//        │                           or, for older rows, its requestFingerprint)
//        └──► final master          (EpisodeAudioRender.diagnostics.provenance:
//                                    the script fingerprint AND the exact audio
//                                    sources that were mixed)
//
// Everything here is pure (no database) so the same function backs the release
// gate (validateEpisodeForRss), the quality inspector and the tests. Nothing is
// ever CLAIMED for an artifact made before its provenance was recorded: an
// older artifact is either proven another way (stated as such) or reported as
// unproven and refused.
import crypto from "crypto";
import { sceneRequestFingerprint } from "../audio/dialogueScenePlanner";
import { PERFORMANCE_PROFILE_VERSION } from "../hosts/performanceProfile";

export const PROVENANCE_VERSION = 1;
/** A render still "running" after this long is a crashed job, not a rebuild. */
const REBUILD_WINDOW_MS = 30 * 60 * 1000;

const sha = (v: unknown) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");

export type Turn = { lineIndex: number; speakerHostId: string; text: string };

/** Every spoken line, read the same way the scene planner reads it. */
export function scriptTurns(content: unknown): Turn[] {
  const segments = (content as { segments?: { lines?: Record<string, unknown>[] }[] } | null)?.segments;
  const out: Turn[] = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    for (const ln of Array.isArray(seg?.lines) ? seg.lines : []) {
      if (!ln || typeof ln.lineIndex !== "number") continue;
      out.push({ lineIndex: ln.lineIndex, speakerHostId: String(ln.speakerHostId ?? ""), text: String(ln.text ?? "") });
    }
  }
  return out;
}

export const turnsHash = (turns: Turn[]) => sha(turns.map((t) => [t.lineIndex, t.speakerHostId, t.text]));
/** What the whole script says: every line, its speaker, its order. */
export const scriptFingerprint = (content: unknown) => turnsHash(scriptTurns(content));
const lineHash = (text: string) => sha(text.trim()).slice(0, 16);

/* ------------------------------ fact check ------------------------------ */

/** Stored on every fact check: exactly which words were checked, per line. */
export function checkedLineHashes(content: unknown): Record<string, string> {
  return Object.fromEntries(scriptTurns(content).map((t) => [String(t.lineIndex), lineHash(t.text)]));
}

/**
 * Lines whose words are not the words the latest fact check read.
 * `checkedLines` absent (a check made before this was recorded) -> fall back to
 * the `dirty` mark an edit leaves, which is all that older checks have.
 */
export function uncheckedLineIndexes(content: unknown, checkedLines: unknown): number[] {
  const segments = (content as { segments?: { lines?: Record<string, unknown>[] }[] } | null)?.segments;
  const lines = (Array.isArray(segments) ? segments : []).flatMap((s) => (Array.isArray(s?.lines) ? s.lines : []));
  if (checkedLines && typeof checkedLines === "object") {
    const rec = checkedLines as Record<string, string>;
    return lines
      .filter((l) => l && typeof l.lineIndex === "number" && rec[String(l.lineIndex)] !== lineHash(String(l.text ?? "")))
      .map((l) => l.lineIndex as number);
  }
  return lines.filter((l) => l?.dirty === true && typeof l.lineIndex === "number").map((l) => l.lineIndex as number);
}

/* -------------------------------- audio --------------------------------- */

export type LineAudioRow = { lineIndex: number; text: string; status: string; audioUrl: string | null; durationMs: number | null };
export type SceneAudioRow = {
  id: string;
  sceneIndex: number;
  lineIndexes: unknown;
  status: string;
  selected: boolean;
  audioUrl: string | null;
  provider: string;
  model: string;
  renderUnit: string;
  voiceMap: unknown;
  requestFingerprint: string;
  plannerVersion: number;
  providerMetadata: unknown;
  createdAt: Date;
};
export type RenderRow = {
  renderVersion: number;
  status: string;
  scriptId: string | null;
  outputAudioUrl: string | null;
  diagnostics: unknown;
  startedAt: Date;
  completedAt: Date | null;
};
export type MasterProvenance = { v: number; scriptId: string; scriptFingerprint: string; sourcesFingerprint: string; mode: "scene" | "line" };

/** Identity of the exact audio a master was mixed from. A re-voiced scene is a
 *  new row (new id); a re-voiced line rewrites its text/url/duration in place. */
export function sourcesFingerprint(src: { scenes?: Pick<SceneAudioRow, "id" | "sceneIndex">[]; lines?: Pick<LineAudioRow, "lineIndex" | "text" | "audioUrl" | "durationMs">[] }): string {
  const scenes = [...(src.scenes ?? [])].sort((a, b) => a.sceneIndex - b.sceneIndex).map((s) => [s.sceneIndex, s.id]);
  const lines = [...(src.lines ?? [])].sort((a, b) => a.lineIndex - b.lineIndex).map((l) => [l.lineIndex, l.text, l.audioUrl, l.durationMs]);
  return sha({ scenes, lines });
}

/** Written into EpisodeAudioRender.diagnostics.provenance by both stitchers,
 *  from the script and the rows they ACTUALLY read at the start of the mix. */
export function buildMasterProvenance(scriptId: string, content: unknown, src: Parameters<typeof sourcesFingerprint>[0]): MasterProvenance {
  return { v: PROVENANCE_VERSION, scriptId, scriptFingerprint: scriptFingerprint(content), sourcesFingerprint: sourcesFingerprint(src), mode: src.scenes?.length ? "scene" : "line" };
}

/** Written into DialogueSceneAudio.providerMetadata.provenance when a scene is voiced. */
export const sceneProvenance = (turns: Turn[]) => ({ v: PROVENANCE_VERSION, turnsHash: turnsHash(turns) });

function sceneMatchesScript(row: SceneAudioRow, turns: Turn[]): boolean {
  const recorded = (row.providerMetadata as { provenance?: { turnsHash?: string } } | null)?.provenance?.turnsHash;
  if (recorded) return recorded === turnsHash(turns);
  // Older row: its requestFingerprint already covers the text and speakers.
  // Recompute it from the row's own stored settings and today's words. The
  // render unit and seed are tried both ways because the row keeps the unit it
  // ENDED on, not necessarily the one it was fingerprinted with.
  const voiceMap = (row.voiceMap as Record<string, string>) ?? {};
  for (const renderUnit of new Set([row.renderUnit, "multi_speaker_scene", "single_line"])) {
    for (const seed of [0, undefined]) {
      const fp = sceneRequestFingerprint({
        scene: { lineIndexes: turns.map((t) => t.lineIndex), lines: turns as never },
        provider: row.provider, model: row.model, renderUnit, voiceMap, seed,
        plannerVersion: row.plannerVersion, profileVersion: PERFORMANCE_PROFILE_VERSION,
      });
      if (fp === row.requestFingerprint) return true;
    }
  }
  return false;
}

const bareUrl = (u: string | null | undefined) => (u ?? "").split("?")[0].trim();
const list = (ns: number[]) => (ns.length > 8 ? `${ns.slice(0, 8).join(", ")} and ${ns.length - 8} more` : ns.join(", "));

export type ArtifactIntegrity = {
  mode: "scene" | "line" | "none";
  staleLines: number[]; // recorded lines whose words changed
  staleScenes: number[]; // sceneIndex of scenes that no longer match (or cannot be shown to)
  unvoicedLines: number[]; // script lines no current audio covers
  master: "current" | "stale" | "unproven" | "rebuilding" | "missing";
  /** How "current" was established: recorded fingerprints, or (older scene
   *  renders only) the mix finishing after every scene it uses was made. */
  masterProof: "recorded" | "timestamps" | null;
  scriptFingerprint: string;
  blockers: string[];
};

export function evaluateArtifactIntegrity(input: {
  scriptId: string;
  content: unknown;
  ttsRenderMode: string | null;
  episodeAudioUrl: string | null;
  lineAudio: LineAudioRow[];
  sceneAudio: SceneAudioRow[];
  renders: RenderRow[];
  now?: Date;
}): ArtifactIntegrity {
  const now = input.now ?? new Date();
  const turns = scriptTurns(input.content);
  const byIndex = new Map(turns.map((t) => [t.lineIndex, t]));
  const blockers: string[] = [];
  const out: ArtifactIntegrity = {
    mode: "none", staleLines: [], staleScenes: [], unvoicedLines: [],
    master: "missing", masterProof: null, scriptFingerprint: turnsHash(turns), blockers,
  };

  const sceneish = input.ttsRenderMode === "scene" || input.ttsRenderMode === "mixed_fallback";
  const selected = input.sceneAudio.filter((s) => s.selected && s.status === "ready" && bareUrl(s.audioUrl));
  const useScenes = input.sceneAudio.length > 0 && (sceneish || input.lineAudio.length === 0);
  let sources: Parameters<typeof sourcesFingerprint>[0] = {};

  if (useScenes) {
    out.mode = "scene";
    const covered = new Set<number>();
    for (const row of selected) {
      const idx = Array.isArray(row.lineIndexes) ? (row.lineIndexes as number[]) : [];
      const sceneTurns = idx.map((i) => byIndex.get(i));
      const overlaps = idx.some((i) => covered.has(i));
      idx.forEach((i) => covered.add(i));
      if (overlaps || sceneTurns.some((t) => !t) || !sceneMatchesScript(row, sceneTurns as Turn[])) out.staleScenes.push(row.sceneIndex);
    }
    out.unvoicedLines = turns.filter((t) => !covered.has(t.lineIndex)).map((t) => t.lineIndex);
    out.staleScenes.sort((a, b) => a - b);
    if (out.staleScenes.length) blockers.push(`Scene audio no longer matches the script (scene ${list(out.staleScenes.map((s) => s + 1))}). Re-voice ${out.staleScenes.length === 1 ? "that scene" : "those scenes"}, then re-mix.`);
    if (out.unvoicedLines.length) blockers.push(`${out.unvoicedLines.length} script line${out.unvoicedLines.length === 1 ? " has" : "s have"} no finished scene audio (line ${list(out.unvoicedLines)}). A scene is missing, failed or still being voiced.`);
    sources = { scenes: selected };
  } else if (input.lineAudio.length > 0) {
    out.mode = "line";
    const ready = input.lineAudio.filter((l) => l.status === "ready");
    const recorded = new Map(ready.map((l) => [l.lineIndex, l.text.trim()]));
    out.staleLines = turns.filter((t) => recorded.has(t.lineIndex) && recorded.get(t.lineIndex) !== t.text.trim()).map((t) => t.lineIndex);
    out.unvoicedLines = turns.filter((t) => !recorded.has(t.lineIndex)).map((t) => t.lineIndex);
    if (out.staleLines.length) blockers.push(`${out.staleLines.length} recorded line${out.staleLines.length === 1 ? " no longer matches" : "s no longer match"} the script (line ${list(out.staleLines)}). Re-voice ${out.staleLines.length === 1 ? "it" : "them"} before publishing.`);
    // Missing / failed line audio is itemised by the release gate itself.
    sources = { lines: ready };
  }

  // ---- The final master must be the mix of exactly this script and these sources ----
  const audioUrl = bareUrl(input.episodeAudioUrl);
  if (!audioUrl) return out; // "no audio" is reported by the release gate
  const renders = [...input.renders].sort((a, b) => b.renderVersion - a.renderVersion);
  const rebuilding = renders.find((r) => r.status === "running" && now.getTime() - new Date(r.startedAt).getTime() < REBUILD_WINDOW_MS);
  if (rebuilding) {
    out.master = "rebuilding";
    blockers.push("The final mix is being rebuilt right now. Publish when it finishes.");
    return out;
  }
  const latest = renders.find((r) => r.status === "succeeded");
  const stale = (why: string) => { out.master = "stale"; blockers.push(`${why} Re-mix the episode (no new voice cost) before publishing.`); return out; };
  if (!latest) {
    out.master = "unproven";
    blockers.push("There is no record of how this episode's final audio was mixed, so it cannot be shown to match the script. Re-mix the episode (no new voice cost) before publishing.");
    return out;
  }
  if (bareUrl(latest.outputAudioUrl) !== audioUrl) return stale("The episode's audio file is not its latest finished mix.");
  if (latest.scriptId !== input.scriptId) return stale("The final mix was made from a different version of the script.");

  const prov = (latest.diagnostics as { provenance?: MasterProvenance } | null)?.provenance;
  if (prov && prov.v === PROVENANCE_VERSION) {
    if (prov.scriptFingerprint !== out.scriptFingerprint) return stale("The script changed after the final mix was made.");
    if (prov.sourcesFingerprint !== sourcesFingerprint(sources)) return stale("Audio was re-voiced after the final mix was made, so the mix does not contain the current recordings.");
    out.master = "current";
    out.masterProof = "recorded";
    return out;
  }
  // A mix made before provenance was recorded. Scenes are append-only rows, so
  // "the mix finished after every scene it uses was created" is real proof.
  // Line audio is rewritten in place and leaves no such trail.
  if (out.mode === "scene" && latest.completedAt) {
    const newest = Math.max(0, ...selected.map((s) => new Date(s.createdAt).getTime()));
    if (newest > new Date(latest.completedAt).getTime()) return stale("A scene was re-voiced after the final mix was made.");
    out.master = "current";
    out.masterProof = "timestamps";
    return out;
  }
  out.master = "unproven";
  blockers.push("This final mix was made before the app recorded what each mix contains, so it cannot be shown to match the script. Re-mix the episode once (no new voice cost) before publishing.");
  return out;
}
