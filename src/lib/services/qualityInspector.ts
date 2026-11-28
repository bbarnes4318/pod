// The one editorial quality report for an episode.
//
// Quality signals used to be spread over five panels (fact-check panel,
// editorial gate, business verification, mix view, publish panel), each with
// its own wording, so "what is stopping this episode?" had no single answer.
// This gathers them into one list with two levels:
//
//   blocker  the pipeline or the publish gate WILL refuse until it is fixed
//   warning  worth a look; nothing refuses because of it
//
// Every item is read from a gate or record that already exists. Nothing here
// decides whether an episode may proceed: the gates do. If this list and a
// gate ever disagree, the gate is right and this file has a bug.

import { staleAudioLineIndexes } from "./rssPublishingService";
import { db } from "@/lib/db";
import { getEpisodeTranscriptVM, type TranscriptVM } from "./transcriptView";
import { evaluateDownstreamBlock } from "./scriptEditorialGate";
import { evaluateBusinessRelease } from "@/lib/business/businessVerification";
import { flattenScriptLines, staleLineIndexes } from "./passageRevision";

export type QualityArea = "Script" | "Facts" | "Editorial" | "Audio" | "Release";

export interface QualityItem {
  id: string;
  severity: "blocker" | "warning";
  area: QualityArea;
  title: string;
  detail: string | null;
  /** The script line to open, when the item is about one. */
  lineIndex: number | null;
  /** The episode stage where it is fixed (a workspace tab key). */
  tab: "transcript" | "produce" | "publish";
}

export interface QualityReport {
  ok: boolean;
  error?: string;
  blockers: QualityItem[];
  warnings: QualityItem[];
  /** Lines whose recording no longer matches the script (per-line voicing only). */
  staleAudioLines: number[];
  checkedAtIso: string;
}

export interface QualityInput {
  vm: TranscriptVM;
  editorial: { blocked: boolean; reasons: string[]; failedCriticalAxes: string[] } | null;
  business: { applies: boolean; allowed: boolean; reasons: string[] } | null;
  staleAudioLines: number[];
  failedAudioLines: number[];
  /** Reasons from the publish gate, when the episode is far enough along for it to apply. */
  publishBlockers: string[];
}

const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Pure: the same inputs always give the same report. */
export function buildQualityReport(input: QualityInput): Pick<QualityReport, "blockers" | "warnings"> {
  const { vm } = input;
  const blockers: QualityItem[] = [];
  const warnings: QualityItem[] = [];
  const add = (list: QualityItem[], item: Omit<QualityItem, "severity">) =>
    list.push({ ...item, severity: list === blockers ? "blocker" : "warning" });

  if (!vm.scriptId || vm.segments.length === 0) {
    add(blockers, { id: "no-script", area: "Script", title: "There is no script yet", detail: "It appears once the episode has been written.", lineIndex: null, tab: "transcript" });
    return { blockers, warnings };
  }

  // ---- Facts: exactly the conditions transcriptView's publish gate enforces ----
  if (!vm.factCheck.present) {
    add(blockers, { id: "fc-missing", area: "Facts", title: "The script has not been fact-checked", detail: "Approve the script and the check runs before anything is recorded.", lineIndex: null, tab: "transcript" });
  } else if (vm.factCheck.status !== "passed") {
    add(blockers, { id: "fc-status", area: "Facts", title: vm.factCheck.status === "failed" ? "The fact check failed" : "The fact check needs review", detail: null, lineIndex: null, tab: "transcript" });
  }
  const claimLines = new Set<number>();
  for (const c of vm.claims) {
    if (c.status === "verified") continue;
    claimLines.add(c.lineIndex);
    add(blockers, {
      id: `claim-${c.lineIndex}`,
      area: "Facts",
      title: c.status === "failed" ? "A claim failed the fact check" : "A claim is not verified",
      detail: `“${clip(c.text)}” ${c.reason ?? ""}`.trim(),
      lineIndex: c.lineIndex,
      tab: "transcript",
    });
  }
  for (const seg of vm.segments) {
    for (const line of seg.lines) {
      if (line.dirty && !claimLines.has(line.lineIndex)) {
        add(blockers, { id: `dirty-${line.lineIndex}`, area: "Facts", title: "A line was edited after the fact check", detail: `“${clip(line.text)}” Run the fact check again to clear it.`, lineIndex: line.lineIndex, tab: "transcript" });
      }
      if (line.requestedTone) {
        add(warnings, { id: `tone-${line.lineIndex}`, area: "Script", title: `A “${line.requestedTone}” change was requested and not applied`, detail: `“${clip(line.text)}” It takes effect on the next rewrite or re-voice.`, lineIndex: line.lineIndex, tab: "transcript" });
      }
    }
  }
  if (vm.factCheck.present && typeof vm.factCheck.coveragePercent === "number" && vm.factCheck.coveragePercent < 100) {
    add(warnings, { id: "coverage", area: "Facts", title: `Evidence covers ${vm.factCheck.coveragePercent}% of the claims`, detail: "Claims without evidence are listed above as not verified.", lineIndex: null, tab: "transcript" });
  }

  // ---- Editorial gate ----
  if (input.editorial?.blocked) {
    add(blockers, {
      id: "editorial",
      area: "Editorial",
      title: "The editorial review is holding this script",
      detail: [...input.editorial.reasons, input.editorial.failedCriticalAxes.length ? `Failed on: ${input.editorial.failedCriticalAxes.join(", ")}.` : ""].filter(Boolean).join(" ") || null,
      lineIndex: null,
      tab: "transcript",
    });
  } else if (input.editorial && input.editorial.reasons.length > 0) {
    add(warnings, { id: "editorial-notes", area: "Editorial", title: "The editorial review left notes", detail: input.editorial.reasons.join(" "), lineIndex: null, tab: "transcript" });
  }

  // ---- Business verification ----
  if (input.business?.applies && !input.business.allowed) {
    add(blockers, { id: "business", area: "Facts", title: "Business fact verification has not cleared this script", detail: input.business.reasons.join(" ") || null, lineIndex: null, tab: "transcript" });
  }

  // ---- Audio ----
  const lineText = new Map(vm.segments.flatMap((s) => s.lines).map((l) => [l.lineIndex, l.text]));
  for (const idx of input.staleAudioLines) {
    add(blockers, { id: `stale-${idx}`, area: "Audio", title: "A recorded line no longer matches the script", detail: `“${clip(lineText.get(idx) ?? "")}” It was edited after it was voiced. Re-voice it so listeners hear the current words.`, lineIndex: idx, tab: "transcript" });
  }
  for (const idx of input.failedAudioLines) {
    add(blockers, { id: `failed-audio-${idx}`, area: "Audio", title: "A line failed to record", detail: `“${clip(lineText.get(idx) ?? "")}” Retry the voices stage.`, lineIndex: idx, tab: "produce" });
  }

  // ---- Release requirements (the publish gate's own words) ----
  const seen = new Set<string>();
  for (const reason of input.publishBlockers) {
    if (seen.has(reason)) continue;
    seen.add(reason);
    add(blockers, { id: `release-${seen.size}`, area: "Release", title: reason, detail: null, lineIndex: null, tab: "publish" });
  }

  return { blockers, warnings };
}

/** Load everything the report reads. The caller must already have checked ownership. */
export async function loadQualityInput(episodeId: string): Promise<{ ok: true; input: Omit<QualityInput, "publishBlockers">; scriptId: string | null; status: string | null } | { ok: false; error: string }> {
  const vm = await getEpisodeTranscriptVM(episodeId);
  if (!vm.ok) return { ok: false, error: vm.error || "The transcript could not be read." };
  if (!vm.scriptId) return { ok: true, input: { vm, editorial: null, business: null, staleAudioLines: [], failedAudioLines: [] }, scriptId: null, status: vm.episodeStatus };

  const [script, segments] = await Promise.all([
    db.script.findUnique({ where: { id: vm.scriptId }, select: { content: true } }),
    db.audioSegment.findMany({ where: { scriptId: vm.scriptId, status: { in: ["ready", "failed"] } }, select: { lineIndex: true, text: true, status: true } }),
  ]);
  const content = script?.content ?? null;
  const editorial = evaluateDownstreamBlock(content);
  const business = evaluateBusinessRelease(content, "tts:generate-segments");
  return {
    ok: true,
    scriptId: vm.scriptId,
    status: vm.episodeStatus,
    input: {
      vm,
      editorial: { blocked: editorial.blocked, reasons: editorial.reasons, failedCriticalAxes: editorial.failedCriticalAxes },
      business: { applies: business.applies, allowed: business.allowed, reasons: business.reasons },
      staleAudioLines: await staleAudioLineIndexes(vm.scriptId),
      failedAudioLines: segments.filter((s) => s.status === "failed").map((s) => s.lineIndex),
    },
  };
}
