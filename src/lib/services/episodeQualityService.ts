// Episode quality rubric — deterministic 0-100 scoring run on every script.
//
// This scorer deliberately avoids rewarding "podcast mannerism compliance".
// A script no longer earns points merely for containing many interruptions,
// short reactions, audio tags, or tone labels. The useful signals are now:
// forward causality, an early unresolved tension, changing positions, character
// asymmetry, concrete material, restraint, and a closing payoff.

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
  "let's dive in",
  "here's the thing",
  "when you really think about it",
];

const META_OPENERS = [
  /^welcome\b/i,
  /^hello\b/i,
  /^hey everybody\b/i,
  /^today (we|we're|we are)\b/i,
  /^on (today'?s|this) (show|episode)\b/i,
  /^let'?s (talk|discuss|dive)\b/i,
];

const RESPONSE_MARKERS = /\b(but|because|so|then|wait|hold on|no|yes|right|exactly|fine|why|how|what|you|your|that|this|which|except|still|actually|okay)\b/i;
const SHIFT_MARKERS = /\b(fine|you'?re right|i was wrong|i'?ll give you|that changes|i didn'?t think|now i wonder|maybe|fair point|i can'?t defend|you got me|i see it)\b/i;
const STAKES_MARKERS = /\b(cost|job|career|season|legacy|trust|seat|fan|owner|family|money|future|lose|win|matter|risk|afraid|care)\b/i;

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

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9']+/g) || [];
}

function contentWords(text: string): Set<string> {
  const stop = new Set(["the", "and", "that", "this", "with", "from", "have", "your", "you", "but", "for", "are", "was", "were", "they", "their", "what", "when", "where", "who", "how", "not", "just", "about", "into", "out", "all"]);
  return new Set(words(text).filter((w) => w.length >= 4 && !stop.has(w)));
}

function overlap(a: string, b: string): number {
  const aa = contentWords(a);
  const bb = contentWords(b);
  if (aa.size === 0 || bb.size === 0) return 0;
  let shared = 0;
  for (const w of aa) if (bb.has(w)) shared++;
  return shared / Math.max(1, Math.min(aa.size, bb.size));
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
  return maxH === 0 ? 0 : h / maxH;
}

export function scoreScriptQuality(content: any): ScriptQualityReport {
  const lines = flatten(content);
  const n = lines.length || 1;
  const allWords = lines.flatMap((l) => words(l.spoken));
  const wordCount = allWords.length || 1;

  // ---- repetition (25) ----
  const rep = findRepetitions(lines.map((l) => l.text));
  const repetitionScore = Math.round(25 * Math.max(0, 1 - rep.repetitionRatio * 5));
  const repetition: QualityAxis = {
    score: repetitionScore,
    max: 25,
    detail: `${rep.repeats.length} near-duplicate line(s) of ${rep.totalLines} (${(rep.repetitionRatio * 100).toFixed(1)}%)`,
  };

  // ---- specificity (15) ----
  const numberHits = lines.reduce((a, l) => a + (l.spoken.match(/\b(\d[\d,.]*|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|dozen|half|double|triple)\b/gi) || []).length, 0);
  const properNouns = lines.reduce((a, l) => a + (l.spoken.match(/\b[A-Z][a-z]{2,}\b/g) || []).length, 0);
  const evidenceLines = lines.filter((l) => l.evidenceRefs.length > 0).length;
  const fillerHits = lines.reduce((a, l) => a + GENERIC_FILLER.filter((f) => l.spoken.toLowerCase().includes(f)).length, 0);
  const concreteDensity = (numberHits + properNouns * 0.35) / wordCount;
  const specificityScore = Math.round(Math.max(0, Math.min(15,
    Math.min(8, concreteDensity * 100 * 1.7) +
    Math.min(5, (evidenceLines / n) * 20) +
    2 - Math.min(6, fillerHits * 2)
  )));
  const specificity: QualityAxis = {
    score: specificityScore,
    max: 15,
    detail: `${numberHits} number refs, ${properNouns} proper nouns, ${evidenceLines}/${n} evidence-backed lines, ${fillerHits} generic filler hit(s)`,
  };

  // ---- personality (15) ----
  const byHost = new Map<string, string[]>();
  for (const l of lines) {
    const list = byHost.get(l.speakerName) || [];
    list.push(...words(l.spoken).filter((w) => w.length > 3));
    byHost.set(l.speakerName, list);
  }
  const hosts = [...byHost.keys()].filter(Boolean);
  let personalityScore = 11;
  let personalityDetail = "solo format — pairwise distinctness not applicable";
  if (hosts.length >= 2) {
    let divergence = 0;
    let lengthContrast = 0;
    let energyContrast = 0;
    let pairs = 0;
    const avgLen = (host: string) => {
      const hostLines = lines.filter((l) => l.speakerName === host);
      return hostLines.reduce((x, l) => x + words(l.spoken).length, 0) / Math.max(1, hostLines.length);
    };
    const highRatio = (host: string) => {
      const hostLines = lines.filter((l) => l.speakerName === host);
      return hostLines.filter((l) => l.energy === "high").length / Math.max(1, hostLines.length);
    };
    for (let i = 0; i < hosts.length; i++) {
      for (let j = i + 1; j < hosts.length; j++) {
        const setA = new Set(byHost.get(hosts[i]));
        const setB = new Set(byHost.get(hosts[j]));
        let inter = 0;
        for (const w of setA) if (setB.has(w)) inter++;
        const union = setA.size + setB.size - inter;
        divergence += union === 0 ? 0 : 1 - inter / union;
        lengthContrast += Math.min(1, Math.abs(avgLen(hosts[i]) - avgLen(hosts[j])) / 12);
        energyContrast += Math.min(1, Math.abs(highRatio(hosts[i]) - highRatio(hosts[j])) / 0.35);
        pairs++;
      }
    }
    divergence /= Math.max(1, pairs);
    lengthContrast /= Math.max(1, pairs);
    energyContrast /= Math.max(1, pairs);
    personalityScore = Math.round(Math.min(15, divergence * 11 + lengthContrast * 2.5 + energyContrast * 1.5));
    personalityDetail = `vocab divergence ${(divergence * 100).toFixed(0)}%, line-shape contrast ${(lengthContrast * 100).toFixed(0)}%, energy contrast ${(energyContrast * 100).toFixed(0)}%`;
  }
  const personality: QualityAxis = { score: personalityScore, max: 15, detail: personalityDetail };

  // ---- flow / causality (20) ----
  let causalLinks = 0;
  let questionResponses = 0;
  let portableGeneric = 0;
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1].spoken;
    const curr = lines[i].spoken;
    const lexical = overlap(prev, curr);
    const responsive = RESPONSE_MARKERS.test(curr) || lexical >= 0.16 || lines[i].isInterruption;
    if (responsive) causalLinks++;
    if (prev.includes("?") && (responsive || curr.length < 45)) questionResponses++;
    if (!responsive && words(curr).length <= 8 && !/[?!—]/.test(curr)) portableGeneric++;
  }
  const linkRatio = causalLinks / Math.max(1, n - 1);
  const questions = lines.filter((l) => l.spoken.includes("?")).length;
  const questionResponseRatio = questionResponses / Math.max(1, questions);
  let alternations = 0;
  let sameSpeakerRuns = 0;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].speakerName !== lines[i - 1].speakerName) alternations++;
    else sameSpeakerRuns++;
  }
  const alternationRatio = alternations / Math.max(1, n - 1);
  const turnShapeScore = alternationRatio >= 0.52 && alternationRatio <= 0.86 ? 4 : alternationRatio >= 0.38 ? 2 : 1;
  const flowScore = Math.round(Math.max(0, Math.min(20,
    linkRatio * 10 + questionResponseRatio * 4 + turnShapeScore + Math.min(2, sameSpeakerRuns / Math.max(1, n) * 10) - Math.min(5, portableGeneric)
  )));
  const flow: QualityAxis = {
    score: flowScore,
    max: 20,
    detail: `${(linkRatio * 100).toFixed(0)}% causally linked turns, ${(questionResponseRatio * 100).toFixed(0)}% question response, ${(alternationRatio * 100).toFixed(0)}% alternation, ${portableGeneric} portable generic fragment(s)`,
  };

  // ---- arc / engagement (15) ----
  const segTypes = (content?.segments || []).map((s: any) => String(s?.type || ""));
  const hasCold = segTypes[0] === "cold_open";
  const hasClose = segTypes[segTypes.length - 1] === "closing";
  const opening = lines.slice(0, 4).map((l) => l.spoken).join(" ");
  const coldStartsWithoutMeta = hasCold && !META_OPENERS.some((r) => r.test(lines[0]?.spoken || ""));
  const openingTension = /[?]|\b(can'?t|won'?t|wrong|problem|why|how|what|cost|risk|lost|dead|fired|lied|refuse)\b/i.test(opening);
  const stakes = lines.filter((l) => STAKES_MARKERS.test(l.spoken)).length;
  const shifts = lines.filter((l) => SHIFT_MARKERS.test(l.spoken)).length;
  const closingText = lines.slice(-4).map((l) => l.spoken).join(" ");
  const closeEchoesOpening = opening && closingText ? overlap(opening, closingText) >= 0.08 : false;
  const arcScore = Math.min(15,
    (coldStartsWithoutMeta ? 4 : hasCold ? 2 : 0) +
    (openingTension ? 3 : 0) +
    (hasClose ? 2 : 0) +
    Math.min(3, shifts) +
    (stakes >= 3 ? 2 : stakes > 0 ? 1 : 0) +
    (closeEchoesOpening ? 1 : 0)
  );
  const arc: QualityAxis = {
    score: arcScore,
    max: 15,
    detail: `cold hook=${coldStartsWithoutMeta}, opening tension=${openingTension}, position shifts=${shifts}, stake lines=${stakes}, closing payoff echo=${closeEchoesOpening}`,
  };

  // ---- delivery restraint (10) ----
  const interruptions = lines.filter((l) => l.isInterruption).length;
  const interruptionRatio = interruptions / n;
  const highRatio = lines.filter((l) => l.energy === "high").length / n;
  const reactionRatio = lines.filter((l) => words(l.spoken).length <= 6).length / n;
  const tagCount = lines.reduce((a, l) => a + (l.text.match(/\[[^\[\]]+\]/g) || []).length, 0);
  const pauseEntropy = entropy(countBy(lines.map((l) => l.pauseBefore)));
  const toneEntropy = entropy(countBy(lines.map((l) => l.tone)));
  const restraintPenalty =
    (interruptionRatio > 0.14 ? 2 : 0) +
    (highRatio > 0.45 ? 2 : 0) +
    (reactionRatio > 0.38 ? 2 : 0) +
    (tagCount > Math.max(10, n * 0.18) ? 2 : 0);
  const deliveryScore = Math.round(Math.max(0, Math.min(10, 5 + pauseEntropy * 2 + toneEntropy * 2 - restraintPenalty)));
  const delivery: QualityAxis = {
    score: deliveryScore,
    max: 10,
    detail: `${interruptions} interruption(s), ${(highRatio * 100).toFixed(0)}% high energy, ${(reactionRatio * 100).toFixed(0)}% short reactions, ${tagCount} audio tag(s), restraint penalty ${restraintPenalty}`,
  };

  const total = repetition.score + specificity.score + personality.score + flow.score + arc.score + delivery.score;
  return { total, axes: { repetition, specificity, personality, flow, arc, delivery } };
}

function countBy(values: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) || 0) + 1);
  return m;
}
