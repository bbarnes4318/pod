// Episode script quality rubric and production gate.
//
// The scorer remains deliberately demanding, but the publishing gate is now
// fail-closed only for catastrophic defects. Editorial weaknesses are retained
// on the script as warnings so the operator can see them without BullMQ blindly
// regenerating the same episode against a stack of overlapping thresholds.

import { stripAudioTags } from "../audio/speechText";
import { findRepetitions } from "./scriptRepetition";
import { scoreConversationContinuity, type ConversationGateMetrics } from "./scriptConversationDirector";

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
  conversation: ConversationGateMetrics;
  gate: {
    enforced: boolean;
    passed: boolean;
    failures: string[];
    warnings: string[];
  };
}

interface FlatLine {
  lineIndex: number;
  speakerName: string;
  text: string;
  spoken: string;
  tone: string;
  energy: string;
  pauseBefore: string;
  isInterruption: boolean;
  isFactualClaim: boolean;
  evidenceRefs: unknown[];
  segmentType: string;
  segmentIndex: number;
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

const SHIFT_MARKERS = /\b(fine|you'?re right|i was wrong|i'?ll give you|that changes|i didn'?t think|now i wonder|maybe|fair point|i can'?t defend|you got me|i see it|okay, that matters)\b/i;
const STAKES_MARKERS = /\b(cost|job|career|season|legacy|trust|seat|fan|owner|family|money|future|lose|win|matter|risk|afraid|care|fired|pressure|reputation)\b/i;
const STOP_WORDS = new Set([
  "the", "and", "that", "this", "with", "from", "have", "your", "you", "but", "for", "are", "was", "were",
  "they", "their", "what", "when", "where", "who", "how", "not", "just", "about", "into", "out", "all", "can",
  "could", "would", "should", "will", "has", "had", "his", "her", "our", "its", "than", "then", "there", "here",
]);

function flatten(content: any): FlatLine[] {
  const out: FlatLine[] = [];
  for (let segmentIndex = 0; segmentIndex < (content?.segments || []).length; segmentIndex++) {
    const segment = content.segments[segmentIndex];
    for (const line of segment?.lines || []) {
      const text = String(line?.text || "");
      out.push({
        lineIndex: Number(line?.lineIndex ?? out.length),
        speakerName: String(line?.speakerName || ""),
        text,
        spoken: stripAudioTags(text).trim(),
        tone: String(line?.tone || ""),
        energy: String(line?.energy || "medium"),
        pauseBefore: String(line?.pauseBefore || "beat"),
        isInterruption: line?.isInterruption === true,
        isFactualClaim: line?.isFactualClaim === true,
        evidenceRefs: Array.isArray(line?.evidenceRefs) ? line.evidenceRefs : [],
        segmentType: String(segment?.type || ""),
        segmentIndex,
      });
    }
  }
  return out;
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9']+/g) || [];
}

function contentWords(text: string): Set<string> {
  return new Set(words(text).filter((word) => word.length >= 4 && !STOP_WORDS.has(word)));
}

function overlap(a: string, b: string): number {
  const aa = contentWords(a);
  const bb = contentWords(b);
  if (!aa.size || !bb.size) return 0;
  let shared = 0;
  for (const word of aa) if (bb.has(word)) shared++;
  return shared / Math.max(1, Math.min(aa.size, bb.size));
}

function entropy(values: string[]): number {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  const total = values.length;
  if (!total || counts.size < 2) return 0;
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / total;
    result -= probability * Math.log2(probability);
  }
  return result / Math.log2(counts.size);
}

function pairwiseVocabularyDivergence(lines: FlatLine[], hosts: string[]): number {
  if (hosts.length < 2) return 0.75;
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < hosts.length; i++) {
    for (let j = i + 1; j < hosts.length; j++) {
      const left = new Set(lines.filter((line) => line.speakerName === hosts[i]).flatMap((line) => words(line.spoken).filter((word) => word.length > 3)));
      const right = new Set(lines.filter((line) => line.speakerName === hosts[j]).flatMap((line) => words(line.spoken).filter((word) => word.length > 3)));
      let intersection = 0;
      for (const word of left) if (right.has(word)) intersection++;
      const union = left.size + right.size - intersection;
      total += union ? 1 - intersection / union : 0;
      pairs++;
    }
  }
  return total / Math.max(1, pairs);
}

function enforceInProduction(): boolean {
  if (process.env.SCRIPT_QUALITY_GATE_STRICT === "false" || process.env.SCRIPT_CONVERSATION_GATE === "false") return false;
  if (process.env.SCRIPT_QUALITY_GATE_STRICT === "true" || process.env.SCRIPT_CONVERSATION_GATE === "true") return true;
  return process.env.NODE_ENV === "production";
}

export function scoreScriptQuality(content: any): ScriptQualityReport {
  const lines = flatten(content);
  const lineCount = lines.length || 1;
  const allWords = lines.flatMap((line) => words(line.spoken));
  const wordCount = allWords.length;
  const hosts = [...new Set(lines.map((line) => line.speakerName).filter(Boolean))];

  const repetitionReport = findRepetitions(lines.map((line) => line.text));
  const repetitionScore = Math.round(25 * Math.max(0, 1 - repetitionReport.repetitionRatio * 5));
  const repetition: QualityAxis = {
    score: repetitionScore,
    max: 25,
    detail: `${repetitionReport.repeats.length} near-duplicate line(s) of ${repetitionReport.totalLines} (${(repetitionReport.repetitionRatio * 100).toFixed(1)}%)`,
  };

  const numberHits = lines.reduce((sum, line) => sum + (line.spoken.match(/\b(\d[\d,.]*|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|dozen|half|double|triple)\b/gi) || []).length, 0);
  const properNouns = lines.reduce((sum, line) => sum + (line.spoken.match(/\b[A-Z][a-z]{2,}\b/g) || []).length, 0);
  const evidenceLines = lines.filter((line) => line.evidenceRefs.length > 0).length;
  const fillerHits = lines.reduce((sum, line) => sum + GENERIC_FILLER.filter((phrase) => line.spoken.toLowerCase().includes(phrase)).length, 0);
  const concreteDensity = (numberHits + properNouns * 0.35) / Math.max(1, wordCount);
  const specificityScore = Math.round(Math.max(0, Math.min(15,
    Math.min(8, concreteDensity * 170) + Math.min(5, (evidenceLines / lineCount) * 20) + 2 - Math.min(8, fillerHits * 2)
  )));
  const specificity: QualityAxis = {
    score: specificityScore,
    max: 15,
    detail: `${numberHits} number refs, ${properNouns} proper nouns, ${evidenceLines}/${lineCount} evidence-backed lines, ${fillerHits} canned filler hit(s)`,
  };

  const vocabularyDivergence = pairwiseVocabularyDivergence(lines, hosts);
  const averageLengthByHost = new Map<string, number>();
  const highEnergyByHost = new Map<string, number>();
  for (const host of hosts) {
    const hostLines = lines.filter((line) => line.speakerName === host);
    averageLengthByHost.set(host, hostLines.reduce((sum, line) => sum + words(line.spoken).length, 0) / Math.max(1, hostLines.length));
    highEnergyByHost.set(host, hostLines.filter((line) => line.energy === "high").length / Math.max(1, hostLines.length));
  }
  let lengthContrast = 0;
  let energyContrast = 0;
  let pairCount = 0;
  for (let i = 0; i < hosts.length; i++) {
    for (let j = i + 1; j < hosts.length; j++) {
      lengthContrast += Math.min(1, Math.abs((averageLengthByHost.get(hosts[i]) || 0) - (averageLengthByHost.get(hosts[j]) || 0)) / 10);
      energyContrast += Math.min(1, Math.abs((highEnergyByHost.get(hosts[i]) || 0) - (highEnergyByHost.get(hosts[j]) || 0)) / 0.28);
      pairCount++;
    }
  }
  lengthContrast /= Math.max(1, pairCount);
  energyContrast /= Math.max(1, pairCount);
  const personalityScore = hosts.length < 2
    ? 11
    : Math.round(Math.min(15, vocabularyDivergence * 10 + lengthContrast * 3 + energyContrast * 2));
  const personality: QualityAxis = {
    score: personalityScore,
    max: 15,
    detail: `vocabulary divergence ${(vocabularyDivergence * 100).toFixed(0)}%, line-shape contrast ${(lengthContrast * 100).toFixed(0)}%, energy contrast ${(energyContrast * 100).toFixed(0)}%`,
  };

  const conversation = scoreConversationContinuity(content?.segments || []);
  const flowScore = Math.round(Math.max(0, Math.min(20,
    conversation.score * 0.16 + conversation.questionResponseRatio * 2 +
    Math.min(2, conversation.sameSpeakerBuilds / Math.max(1, lineCount) * 10)
  )));
  const flow: QualityAxis = {
    score: flowScore,
    max: 20,
    detail: `${conversation.score}/100 conversation score, ${(conversation.responsiveSwitchRatio * 100).toFixed(0)}% responsive speaker switches, ${conversation.disconnectedSwitches} disconnected switch(es), ${conversation.unansweredQuestions}/${conversation.questionCount} unanswered question(s), ${(conversation.strictAlternationRatio * 100).toFixed(0)}% strict alternation`,
  };

  const segmentTypes = (content?.segments || []).map((segment: any) => String(segment?.type || ""));
  const hasColdOpen = segmentTypes[0] === "cold_open";
  const hasClosing = segmentTypes[segmentTypes.length - 1] === "closing";
  const opening = lines.slice(0, 5).map((line) => line.spoken).join(" ");
  const closing = lines.slice(-5).map((line) => line.spoken).join(" ");
  const coldStartsWithoutMeta = hasColdOpen && !META_OPENERS.some((pattern) => pattern.test(lines[0]?.spoken || ""));
  const openingTension = /[?]|\b(can'?t|won'?t|wrong|problem|why|how|what|cost|risk|lost|dead|fired|lied|refuse|absurd)\b/i.test(opening);
  const stakes = lines.filter((line) => STAKES_MARKERS.test(line.spoken)).length;
  const shifts = lines.filter((line) => SHIFT_MARKERS.test(line.spoken)).length;
  const closingEcho = opening && closing ? overlap(opening, closing) >= 0.07 : false;
  const arcScore = Math.min(15,
    (coldStartsWithoutMeta ? 4 : hasColdOpen ? 2 : 0) +
    (openingTension ? 3 : 0) +
    (hasClosing ? 2 : 0) +
    Math.min(3, shifts) +
    (stakes >= 3 ? 2 : stakes > 0 ? 1 : 0) +
    (closingEcho ? 1 : 0)
  );
  const arc: QualityAxis = {
    score: arcScore,
    max: 15,
    detail: `cold hook=${coldStartsWithoutMeta}, opening tension=${openingTension}, position shifts=${shifts}, stake lines=${stakes}, closing payoff echo=${closingEcho}`,
  };

  const interruptions = lines.filter((line) => line.isInterruption).length;
  const highRatio = lines.filter((line) => line.energy === "high").length / lineCount;
  const reactionRatio = lines.filter((line) => words(line.spoken).length <= 6).length / lineCount;
  const tagCount = lines.reduce((sum, line) => sum + (line.text.match(/\[[^\[\]]+\]/g) || []).length, 0);
  const pauseEntropy = entropy(lines.map((line) => line.pauseBefore));
  const toneEntropy = entropy(lines.map((line) => line.tone));
  const restraintPenalty =
    (interruptions / lineCount > 0.14 ? 2 : 0) +
    (highRatio > 0.45 ? 2 : 0) +
    (reactionRatio > 0.40 ? 2 : 0) +
    (tagCount > Math.max(10, lineCount * 0.18) ? 2 : 0);
  const deliveryScore = Math.round(Math.max(0, Math.min(10, 5 + pauseEntropy * 2 + toneEntropy * 2 - restraintPenalty)));
  const delivery: QualityAxis = {
    score: deliveryScore,
    max: 10,
    detail: `${interruptions} interruption(s), ${(highRatio * 100).toFixed(0)}% high energy, ${(reactionRatio * 100).toFixed(0)}% short reactions, ${tagCount} audio tag(s), restraint penalty ${restraintPenalty}`,
  };

  const total = repetition.score + specificity.score + personality.score + flow.score + arc.score + delivery.score;
  const warnings: string[] = [];
  const failures: string[] = [];
  const targetMinutes = Math.max(1, Number(content?.estimatedDurationMinutes) || 0);
  const minimumWords = Math.round(targetMinutes * 105);
  const catastrophicWordFloor = Math.round(minimumWords * 0.72);

  // Editorial targets remain visible and measurable. They no longer create an
  // infinite retry loop when the script is coherent but misses one heuristic.
  if (conversation.score < 78) warnings.push(`conversation continuity ${conversation.score}/100 is below the 78 editorial target`);
  if (conversation.speakerSwitches >= 5 && conversation.responsiveSwitchRatio < 0.66) warnings.push(`only ${Math.round(conversation.responsiveSwitchRatio * 100)}% of speaker switches answer the preceding turn`);
  if (conversation.disconnectedSwitches > Math.max(2, Math.floor(conversation.speakerSwitches * 0.18))) warnings.push(`${conversation.disconnectedSwitches} speaker switches may begin a separate thought`);
  if (conversation.questionCount >= 2 && conversation.questionResponseRatio < 0.70) warnings.push(`${conversation.unansweredQuestions} direct question(s) may go unanswered`);
  if (conversation.strictAlternationRatio > 0.94 && conversation.sameSpeakerBuilds < 2) warnings.push(`mechanical ping-pong risk: ${Math.round(conversation.strictAlternationRatio * 100)}% of adjacent lines alternate speakers`);
  if (wordCount < minimumWords) warnings.push(`${wordCount} spoken words are below the ${minimumWords}-word duration target for ${targetMinutes} minutes`);
  if (flow.score < 14) warnings.push(`flow score ${flow.score}/20 is below the 14 editorial target`);
  if (hosts.length >= 2 && personality.score < 9) warnings.push(`host differentiation ${personality.score}/15 is below the 9 editorial target`);
  if (arc.score < 8) warnings.push(`dramatic arc ${arc.score}/15 is below the 8 editorial target`);
  if (total < 76) warnings.push(`overall script quality ${total}/100 is below the 76 editorial target`);

  // Hard failures are reserved for drafts that are plainly unusable. These are
  // intentionally far below the editorial targets and are independent signals,
  // not several restatements of the same slightly-low score.
  if (conversation.score < 55) failures.push(`catastrophic conversation continuity ${conversation.score}/100 is below 55`);
  if (conversation.speakerSwitches >= 5 && conversation.responsiveSwitchRatio < 0.40) failures.push(`only ${Math.round(conversation.responsiveSwitchRatio * 100)}% of speaker switches respond to the preceding turn`);
  if (conversation.disconnectedSwitches > Math.max(5, Math.floor(conversation.speakerSwitches * 0.42))) failures.push(`${conversation.disconnectedSwitches} of ${conversation.speakerSwitches} speaker switches are disconnected`);
  if (conversation.questionCount >= 3 && conversation.questionResponseRatio < 0.40) failures.push(`${conversation.unansweredQuestions} of ${conversation.questionCount} direct questions go unanswered`);
  if (wordCount < catastrophicWordFloor) failures.push(`${wordCount} spoken words are below the catastrophic duration floor of ${catastrophicWordFloor}`);
  if (total < 58) failures.push(`overall script quality ${total}/100 is below the catastrophic floor of 58`);

  const enforced = enforceInProduction();
  const gate = { enforced, passed: failures.length === 0, failures, warnings };
  const report: ScriptQualityReport = {
    total,
    axes: { repetition, specificity, personality, flow, arc, delivery },
    conversation,
    gate,
  };

  if (enforced && failures.length > 0) {
    throw new Error(
      `Script quality gate rejected a catastrophically bad draft before save: ${failures.join("; ")}. ` +
      `Editorial warnings: ${warnings.join("; ") || "none"}.`
    );
  }

  return report;
}
