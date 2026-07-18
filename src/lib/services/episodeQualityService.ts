// Episode quality rubric — deterministic 0-100 scoring run on every script.
//
// Axes (max points):
//   repetition   25  — near-duplicate lines; the catastrophic failure mode
//   specificity  20  — concrete numbers/names/evidence vs generic filler
//   personality  15  — hosts measurably sound like different people
//   flow         15  — real conversation: reactions, interruptions, rhythm
//   arc          10  — cold open, escalation, callbacks, closing button
//   delivery     15  — tone/energy variety + audio-tag usage for TTS acting
//
// The scorer is intentionally deterministic (no LLM): fast, free, and
// regression-stable, so it can gate every generation.

import { stripAudioTags } from "../audio/speechText";
import { findRepetitions } from "./scriptRepetition";

export interface QualityAxis {
  score: number;
  max: number;
  detail: string;
}

export interface ScriptQualityReport {
  total: number;
  axes: {
    repetition: QualityAxis;
    specificity: QualityAxis;
    personality: QualityAxis;
    flow: QualityAxis;
    arc: QualityAxis;
    delivery: QualityAxis;
  };
}

const GENERIC_FILLER = [
  "at the end of the day",
  "it is what it is",
  "only time will tell",
  "one thing is for sure",
  "one thing's for sure",
  "the numbers speak for themselves",
  "when it's all said and done",
  "love to see it",
  "at this point in time",
  "time will tell",
];

interface FlatLine {
  speakerName: string;
  text: string;
  spoken: string;
  tone: string;
  energy: string;
  pauseBefore: string;
  isInterruption: boolean;
  isFactualClaim: boolean;
  evidenceRefs: any[];
  segmentType: string;
}

function flatten(content: any): FlatLine[] {
  const out: FlatLine[] = [];
  for (const seg of content?.segments || []) {
    for (const line of seg?.lines || []) {
      const text = String(line?.text || "");
      out.push({
        speakerName: String(line?.speakerName || ""),
        text,
        spoken: stripAudioTags(text),
        tone: String(line?.tone || ""),
        energy: String(line?.energy || "medium"),
        pauseBefore: String(line?.pauseBefore || "beat"),
        isInterruption: line?.isInterruption === true,
        isFactualClaim: line?.isFactualClaim === true,
        evidenceRefs: Array.isArray(line?.evidenceRefs) ? line.evidenceRefs : [],
        segmentType: String(seg?.type || ""),
      });
    }
  }
  return out;
}

function entropy(counts: Map<string, number>): number {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let h = 0;
  for (const c of counts.values()) {
    if (c === 0) continue;
    const p = c / total;
    h -= p * Math.log2(p);
  }
  const maxH = Math.log2(Math.max(2, counts.size));
  return maxH === 0 ? 0 : h / maxH; // normalized 0..1
}

export function scoreScriptQuality(content: any): ScriptQualityReport {
  const lines = flatten(content);
  const n = lines.length || 1;
  const allWords = lines.flatMap((l) => l.spoken.toLowerCase().split(/\s+/).filter(Boolean));
  const wordCount = allWords.length || 1;

  // ---- repetition (25) ----
  const rep = findRepetitions(lines.map((l) => l.text));
  const repetitionScore = Math.round(25 * Math.max(0, 1 - rep.repetitionRatio * 5));
  const repetition: QualityAxis = {
    score: repetitionScore,
    max: 25,
    detail: `${rep.repeats.length} near-duplicate line(s) of ${rep.totalLines} (${(rep.repetitionRatio * 100).toFixed(1)}%)`,
  };

  // ---- specificity (20) ----
  const numberHits = lines.reduce((a, l) => a + (l.spoken.match(/\b(\d[\d,.]*|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|dozen|half|double|triple)\b/gi) || []).length, 0);
  const properNouns = lines.reduce((a, l) => a + (l.spoken.match(/\b[A-Z][a-z]{2,}\b/g) || []).length, 0);
  const evidenceLines = lines.filter((l) => l.evidenceRefs.length > 0).length;
  const fillerHits = lines.reduce(
    (a, l) => a + GENERIC_FILLER.filter((f) => l.spoken.toLowerCase().includes(f)).length,
    0
  );
  const densityScore = Math.min(12, ((numberHits + properNouns * 0.4) / wordCount) * 100 * 1.6);
  const evidenceScore = Math.min(6, (evidenceLines / n) * 24);
  const fillerPenalty = Math.min(6, fillerHits * 2);
  const specScore = Math.round(Math.max(0, Math.min(20, densityScore + evidenceScore + 2 - fillerPenalty)));
  const specificity: QualityAxis = {
    score: specScore,
    max: 20,
    detail: `${numberHits} number refs, ${properNouns} proper nouns, ${evidenceLines}/${n} evidence-backed lines, ${fillerHits} filler phrase(s)`,
  };

  // ---- personality (15) ----
  const byHost = new Map<string, string[]>();
  for (const l of lines) {
    const list = byHost.get(l.speakerName) || [];
    list.push(...l.spoken.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
    byHost.set(l.speakerName, list);
  }
  const hosts = [...byHost.keys()].filter(Boolean);
  // Prompt 7: distinctness runs over EVERY speaker pair (averaged), so a
  // 3-4 voice script scores all its voices, not just the first two. A solo
  // script has no pair to contrast — it earns a fixed solid score for the
  // axis rather than an impossible one.
  let divergence = 0;
  let lengthContrast = 0;
  let personalityScore: number;
  let personalityDetail: string;
  if (hosts.length >= 2) {
    const avgLen = (host: string) => {
      const hostLines = lines.filter((l) => l.speakerName === host);
      return hostLines.reduce((x, l) => x + l.spoken.length, 0) / Math.max(1, hostLines.length);
    };
    let pairs = 0;
    for (let i = 0; i < hosts.length; i++) {
      for (let j = i + 1; j < hosts.length; j++) {
        const setA = new Set(byHost.get(hosts[i]));
        const setB = new Set(byHost.get(hosts[j]));
        let inter = 0;
        for (const w of setA) if (setB.has(w)) inter++;
        const union = setA.size + setB.size - inter;
        divergence += union === 0 ? 0 : 1 - inter / union;
        lengthContrast += Math.min(1, Math.abs(avgLen(hosts[i]) - avgLen(hosts[j])) / 60);
        pairs++;
      }
    }
    divergence /= Math.max(1, pairs);
    lengthContrast /= Math.max(1, pairs);
    personalityScore = Math.round(Math.min(15, divergence * 14 + lengthContrast * 4));
    personalityDetail = `vocab divergence ${(divergence * 100).toFixed(0)}%, line-length contrast ${(lengthContrast * 100).toFixed(0)}% (avg over ${pairs} pair${pairs === 1 ? "" : "s"})`;
  } else {
    personalityScore = 11; // solo: axis not applicable; a fair fixed grade
    personalityDetail = "solo format — pairwise distinctness not applicable";
  }
  const personality: QualityAxis = {
    score: personalityScore,
    max: 15,
    detail: personalityDetail,
  };

  // ---- flow (15) ----
  const reactionLines = lines.filter((l) => l.spoken.split(/\s+/).filter(Boolean).length <= 6).length;
  const reactionRatio = reactionLines / n;
  const reactionScore = reactionRatio >= 0.12 && reactionRatio <= 0.4 ? 5 : reactionRatio > 0 ? 3 : 0;
  const interruptions = lines.filter((l) => l.isInterruption).length;
  const interruptionScore = interruptions >= 2 && interruptions <= 10 ? 4 : interruptions > 0 ? 2 : 0;
  let alternations = 0;
  for (let i = 1; i < lines.length; i++) if (lines[i].speakerName !== lines[i - 1].speakerName) alternations++;
  const alternationRatio = alternations / Math.max(1, n - 1);
  const alternationScore = alternationRatio >= 0.5 ? 3 : alternationRatio >= 0.35 ? 2 : 1;
  const lengths = lines.map((l) => l.spoken.length);
  const mean = lengths.reduce((a, b) => a + b, 0) / n;
  const cv = mean === 0 ? 0 : Math.sqrt(lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / n) / mean;
  const rhythmScore = cv >= 0.45 ? 3 : cv >= 0.3 ? 2 : 1;
  const flowScore = Math.min(15, reactionScore + interruptionScore + alternationScore + rhythmScore);
  const flow: QualityAxis = {
    score: flowScore,
    max: 15,
    detail: `${(reactionRatio * 100).toFixed(0)}% reaction lines, ${interruptions} interruption(s), ${(alternationRatio * 100).toFixed(0)}% turn alternation, length CV ${cv.toFixed(2)}`,
  };

  // ---- arc (10) ----
  const segTypes = (content?.segments || []).map((s: any) => String(s?.type || ""));
  const hasCold = segTypes[0] === "cold_open";
  const hasClose = segTypes[segTypes.length - 1] === "closing";
  const typeVariety = new Set(segTypes).size >= 3;
  const arcScore = (hasCold ? 4 : 0) + (hasClose ? 3 : 0) + (typeVariety ? 3 : 0);
  const arc: QualityAxis = {
    score: arcScore,
    max: 10,
    detail: `cold_open first: ${hasCold}, closing last: ${hasClose}, segment variety: ${typeVariety}`,
  };

  // ---- delivery (15) ----
  const toneEntropy = entropy(countBy(lines.map((l) => l.tone)));
  const energyEntropy = entropy(countBy(lines.map((l) => l.energy)));
  const pauseEntropy = entropy(countBy(lines.map((l) => l.pauseBefore)));
  const tagCount = lines.reduce((a, l) => a + (l.text.match(/\[[^\[\]]+\]/g) || []).length, 0);
  const tagScore = tagCount >= 3 && tagCount <= 15 ? 4 : tagCount > 0 ? 2 : 0;
  const deliveryScore = Math.round(Math.min(15, toneEntropy * 5 + energyEntropy * 3.5 + pauseEntropy * 2.5 + tagScore));
  const delivery: QualityAxis = {
    score: deliveryScore,
    max: 15,
    detail: `tone variety ${(toneEntropy * 100).toFixed(0)}%, energy variety ${(energyEntropy * 100).toFixed(0)}%, ${tagCount} audio tag(s)`,
  };

  const total =
    repetition.score + specificity.score + personality.score + flow.score + arc.score + delivery.score;

  return {
    total,
    axes: { repetition, specificity, personality, flow, arc, delivery },
  };
}

function countBy(values: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) || 0) + 1);
  return m;
}
