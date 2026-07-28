import { stripAudioTags } from "../audio/speechText";
import { withLlmStage } from "../providers/llm/costLedger";

interface StructuredLlm {
  generateStructuredOutput<T>(input: {
    prompt: string;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
    validate?: (value: T) => string | null;
  }): Promise<T>;
}

export interface ConversationGateMetrics {
  score: number;
  speakerSwitches: number;
  responsiveSwitches: number;
  responsiveSwitchRatio: number;
  unansweredQuestions: number;
  questionCount: number;
  questionResponseRatio: number;
  disconnectedSwitches: number;
  strictAlternationRatio: number;
  sameSpeakerBuilds: number;
  portableMonologueStarts: number;
}

export interface ConversationSemanticReview {
  pass: boolean;
  score: number;
  problems: Array<{
    segmentIndex: number;
    lineIndexes: number[];
    problem: string;
    repairInstruction: string;
  }>;
  summary: string;
}

export interface ConversationDirectorReport {
  strict: boolean;
  rounds: number;
  rewrittenLines: number;
  before: ConversationGateMetrics;
  after: ConversationGateMetrics;
  semanticBefore?: ConversationSemanticReview;
  semanticAfter?: ConversationSemanticReview;
  passed: boolean;
  reasons: string[];
}

interface DirectorOptions {
  reviewLlm: StructuredLlm;
  rewriteLlm: StructuredLlm;
  hostNames: string[];
  strict?: boolean;
  maxRounds?: number;
  minDeterministicScore?: number;
  minSemanticScore?: number;
  log?: (message: string) => void;
}

interface ScriptLine {
  lineIndex: number;
  speakerName: string;
  text: string;
  tone?: string;
  energy?: string;
  pauseBefore?: string;
  isInterruption?: boolean;
  evidenceRefs?: unknown[];
  isFactualClaim?: boolean;
  needsHumanReview?: boolean;
  [key: string]: unknown;
}

interface ScriptSegment {
  type?: string;
  title?: string;
  topicId?: string;
  lines: ScriptLine[];
  [key: string]: unknown;
}

const RESPONSE_START = /^(no\b|yes\b|yeah\b|right\b|exactly\b|wait\b|hold on\b|come on\b|okay\b|fine\b|but\b|because\b|so\b|then\b|what\b|why\b|how\b|you\b|your\b|that\b|this\b|which\b|except\b|still\b|actually\b|sure\b)/i;
const DIRECT_ADDRESS = /\b(you|your|you\'re|you\'ve|you\'d|you\'ll)\b/i;
const CALLBACK = /\b(what you just said|that point|your point|you said|you keep saying|you called|you\'re saying|you mean|that argument|that take|that number|that stat|that game)\b/i;
const NEW_TOPIC_OPEN = /^(meanwhile|separately|another thing|next thing|moving on|as for|speaking of|on the other hand)\b/i;
const STOP_WORDS = new Set([
  "the", "and", "that", "this", "with", "from", "have", "your", "you", "but", "for", "are", "was", "were",
  "they", "their", "what", "when", "where", "who", "how", "not", "just", "about", "into", "out", "all", "can",
  "could", "would", "should", "will", "has", "had", "his", "her", "our", "its", "than", "then", "there", "here",
]);

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9']+/g) || [];
}

function contentWords(text: string): Set<string> {
  return new Set(words(text).filter((word) => word.length >= 4 && !STOP_WORDS.has(word)));
}

function lexicalOverlap(a: string, b: string): number {
  const aa = contentWords(a);
  const bb = contentWords(b);
  if (aa.size === 0 || bb.size === 0) return 0;
  let shared = 0;
  for (const word of aa) if (bb.has(word)) shared++;
  return shared / Math.max(1, Math.min(aa.size, bb.size));
}

function spoken(line: ScriptLine): string {
  return stripAudioTags(String(line.text || "")).trim();
}

function isResponsive(prev: ScriptLine, curr: ScriptLine, previousTwoText: string): boolean {
  const prevText = spoken(prev);
  const currText = spoken(curr);
  if (!currText) return false;
  if (curr.isInterruption === true) return true;
  if (RESPONSE_START.test(currText) || CALLBACK.test(currText)) return true;
  if (DIRECT_ADDRESS.test(currText) && !NEW_TOPIC_OPEN.test(currText)) return true;
  if (lexicalOverlap(prevText, currText) >= 0.12) return true;
  if (previousTwoText && lexicalOverlap(previousTwoText, currText) >= 0.16) return true;
  if (prevText.endsWith("?") && words(currText).length <= 28) return true;
  if (/[—-]\s*$/.test(prevText)) return true;
  return false;
}

export function scoreConversationContinuity(segments: ScriptSegment[]): ConversationGateMetrics {
  let speakerSwitches = 0;
  let responsiveSwitches = 0;
  let unansweredQuestions = 0;
  let questionCount = 0;
  let disconnectedSwitches = 0;
  let alternations = 0;
  let adjacentPairs = 0;
  let sameSpeakerBuilds = 0;
  let portableMonologueStarts = 0;

  for (const segment of segments) {
    const lines = Array.isArray(segment.lines) ? segment.lines : [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const text = spoken(line);
      if (text.endsWith("?")) questionCount++;
      if (i === 0) continue;

      adjacentPairs++;
      const prev = lines[i - 1];
      const switched = prev.speakerName !== line.speakerName;
      if (!switched) {
        sameSpeakerBuilds++;
        continue;
      }

      alternations++;
      speakerSwitches++;
      const previousTwoText = i >= 2 ? `${spoken(lines[i - 2])} ${spoken(prev)}` : spoken(prev);
      const responsive = isResponsive(prev, line, previousTwoText);
      if (responsive) responsiveSwitches++;
      else {
        disconnectedSwitches++;
        const lineWords = words(text).length;
        if (lineWords >= 10 && !NEW_TOPIC_OPEN.test(text)) portableMonologueStarts++;
      }

      if (spoken(prev).endsWith("?") && !responsive) unansweredQuestions++;
    }
  }

  const responsiveSwitchRatio = responsiveSwitches / Math.max(1, speakerSwitches);
  const questionResponseRatio = (questionCount - unansweredQuestions) / Math.max(1, questionCount);
  const strictAlternationRatio = alternations / Math.max(1, adjacentPairs);
  const disconnectedRatio = disconnectedSwitches / Math.max(1, speakerSwitches);

  const responsePoints = Math.min(50, responsiveSwitchRatio * 50);
  const questionPoints = Math.min(15, questionResponseRatio * 15);
  const buildPoints = Math.min(10, (sameSpeakerBuilds / Math.max(1, adjacentPairs)) * 35);
  const alternationPenalty = strictAlternationRatio > 0.92 ? 12 : strictAlternationRatio > 0.86 ? 6 : 0;
  const disconnectPenalty = Math.min(25, disconnectedRatio * 35 + portableMonologueStarts * 2.5);
  const score = Math.max(0, Math.min(100, Math.round(35 + responsePoints + questionPoints + buildPoints - alternationPenalty - disconnectPenalty)));

  return {
    score,
    speakerSwitches,
    responsiveSwitches,
    responsiveSwitchRatio,
    unansweredQuestions,
    questionCount,
    questionResponseRatio,
    disconnectedSwitches,
    strictAlternationRatio,
    sameSpeakerBuilds,
    portableMonologueStarts,
  };
}

function compactScriptForReview(segments: ScriptSegment[]) {
  return segments.map((segment, segmentIndex) => ({
    segmentIndex,
    type: segment.type,
    title: segment.title,
    topicId: segment.topicId,
    lines: (segment.lines || []).map((line) => ({
      lineIndex: line.lineIndex,
      speakerName: line.speakerName,
      text: spoken(line),
      isFactualClaim: line.isFactualClaim === true,
    })),
  }));
}

function validateSemanticReview(value: ConversationSemanticReview): string | null {
  if (!value || typeof value !== "object") return "Review is not an object.";
  if (typeof value.pass !== "boolean") return "Review is missing pass.";
  if (!Number.isFinite(value.score)) return "Review is missing numeric score.";
  if (!Array.isArray(value.problems)) return "Review is missing problems array.";
  return null;
}

async function semanticReview(reviewLlm: StructuredLlm, segments: ScriptSegment[], hostNames: string[]): Promise<ConversationSemanticReview> {
  return withLlmStage("script:conversation-review", () =>
    reviewLlm.generateStructuredOutput<ConversationSemanticReview>({
      systemPrompt: `You are the executive producer listening for one thing: does this sound like ${hostNames.join(" and ")} are in the SAME room having ONE live conversation? You are a hostile quality gate, not a helpful copy editor. Reject parallel monologues, adjacent lines that ignore each other, topic jumps without a handoff, interchangeable voices, scripted ping-pong, and emotion labels that are unsupported by the words. A technically valid script can still fail.`,
      prompt: `Judge this podcast script. Score 0-100. PASS requires 82 or higher and no major continuity defect. Every speaker switch should feel caused by what was just said. Short reactions count only when they are specific to the preceding line. Identify exact line indexes that break the conversation.\n\nSCRIPT:\n${JSON.stringify(compactScriptForReview(segments))}\n\nReturn JSON only:\n{\n  "pass": true,\n  "score": 0,\n  "summary": "...",\n  "problems": [\n    {\n      "segmentIndex": 0,\n      "lineIndexes": [1,2],\n      "problem": "...",\n      "repairInstruction": "..."\n    }\n  ]\n}`,
      temperature: 0,
      maxTokens: 5000,
      validate: validateSemanticReview,
    })
  );
}

interface RewriteItem {
  lineIndex: number;
  text: string;
  tone?: string;
  energy?: string;
  pauseBefore?: string;
  isInterruption?: boolean;
}

interface RewritePayload {
  lines: RewriteItem[];
}

function validateRewritePayload(value: RewritePayload): string | null {
  if (!value || typeof value !== "object" || !Array.isArray(value.lines)) return "Rewrite is missing lines array.";
  const seen = new Set<number>();
  for (const line of value.lines) {
    if (!Number.isInteger(line?.lineIndex)) return "Every rewrite line needs an integer lineIndex.";
    if (seen.has(line.lineIndex)) return `Duplicate rewritten lineIndex ${line.lineIndex}.`;
    seen.add(line.lineIndex);
    if (typeof line.text !== "string" || !line.text.trim()) return `Line ${line.lineIndex} has empty text.`;
  }
  return null;
}

function applyRewrites(segments: ScriptSegment[], payload: RewritePayload): { segments: ScriptSegment[]; rewrittenLines: number } {
  const byIndex = new Map(payload.lines.map((line) => [line.lineIndex, line]));
  let rewrittenLines = 0;
  const next = segments.map((segment) => ({
    ...segment,
    lines: (segment.lines || []).map((line) => {
      const rewrite = byIndex.get(line.lineIndex);
      if (!rewrite) return line;
      rewrittenLines++;
      return {
        ...line,
        text: rewrite.text,
        tone: rewrite.tone ?? line.tone,
        energy: rewrite.energy ?? line.energy,
        pauseBefore: rewrite.pauseBefore ?? line.pauseBefore,
        isInterruption: rewrite.isInterruption ?? line.isInterruption,
      };
    }),
  }));
  return { segments: next, rewrittenLines };
}

async function rewriteConversation(
  rewriteLlm: StructuredLlm,
  segments: ScriptSegment[],
  review: ConversationSemanticReview,
  hostNames: string[]
): Promise<RewritePayload> {
  const immutable = segments.flatMap((segment) => (segment.lines || []).map((line) => ({
    lineIndex: line.lineIndex,
    speakerName: line.speakerName,
    originalText: spoken(line),
    isFactualClaim: line.isFactualClaim === true,
    evidenceRefs: line.evidenceRefs || [],
    tone: line.tone,
    energy: line.energy,
    pauseBefore: line.pauseBefore,
    isInterruption: line.isInterruption === true,
  })));

  return withLlmStage("script:conversation-rewrite", () =>
    rewriteLlm.generateStructuredOutput<RewritePayload>({
      systemPrompt: `You are the on-floor showrunner rewriting spoken dialogue for ${hostNames.join(" and ")}. Make it sound improvised, emotionally alive, and causally connected. Each response must answer, challenge, extend, mock, concede, or interrupt the immediately preceding thought. Do not write two parallel essays. Preserve each line's speaker and lineIndex. Never invent a fact, number, name, event, quote, or source. For factual lines, preserve every factual clause exactly and only change the conversational framing around it. Do not add production labels or stage directions outside supported square-bracket delivery cues.`,
      prompt: `Repair the exact continuity failures below. Return one rewritten entry for EVERY line, in original order. Preserve lineIndex and speaker ownership. You may make reaction lines shorter, combine a thought across consecutive lines by the same speaker, and make the next speaker explicitly respond. Do not add or remove lines.\n\nREVIEW:\n${JSON.stringify(review)}\n\nLINES WITH IMMUTABLE METADATA:\n${JSON.stringify(immutable)}\n\nReturn JSON only:\n{\n  "lines": [\n    {\n      "lineIndex": 0,\n      "text": "...",\n      "tone": "heated|sarcastic|analytical|dismissive|amused|incredulous|conceding|excited|reflective|setup|transition",\n      "energy": "low|medium|high",\n      "pauseBefore": "none|beat|breath|long",\n      "isInterruption": false\n    }\n  ]\n}`,
      temperature: 0.7,
      maxTokens: 16000,
      validate: validateRewritePayload,
    })
  );
}

function deterministicPass(metrics: ConversationGateMetrics, minScore: number): boolean {
  const enoughSwitches = metrics.speakerSwitches < 4 || metrics.responsiveSwitchRatio >= 0.66;
  const questionsHandled = metrics.questionCount < 2 || metrics.questionResponseRatio >= 0.7;
  const disconnectedBound = metrics.disconnectedSwitches <= Math.max(2, Math.floor(metrics.speakerSwitches * 0.18));
  const notMechanicalPingPong = metrics.strictAlternationRatio <= 0.94 || metrics.sameSpeakerBuilds >= 2;
  return metrics.score >= minScore && enoughSwitches && questionsHandled && disconnectedBound && notMechanicalPingPong;
}

export async function directConversationScript(
  sourceSegments: ScriptSegment[],
  options: DirectorOptions
): Promise<{ segments: ScriptSegment[]; report: ConversationDirectorReport }> {
  const strict = options.strict !== false;
  const maxRounds = Math.max(0, Math.min(3, options.maxRounds ?? 2));
  const minDeterministicScore = options.minDeterministicScore ?? 78;
  const minSemanticScore = options.minSemanticScore ?? 82;
  const reasons: string[] = [];
  let segments = JSON.parse(JSON.stringify(sourceSegments)) as ScriptSegment[];
  const before = scoreConversationContinuity(segments);
  let after = before;
  let semanticBefore: ConversationSemanticReview | undefined;
  let semanticAfter: ConversationSemanticReview | undefined;
  let rewrittenLines = 0;
  let rounds = 0;

  try {
    semanticBefore = await semanticReview(options.reviewLlm, segments, options.hostNames);
  } catch (error) {
    reasons.push(`Semantic conversation review failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const initiallyPassed = deterministicPass(before, minDeterministicScore) &&
    (!semanticBefore || (semanticBefore.pass && semanticBefore.score >= minSemanticScore));

  if (!initiallyPassed) {
    let currentReview = semanticBefore ?? {
      pass: false,
      score: before.score,
      summary: "Deterministic continuity gate failed.",
      problems: [{
        segmentIndex: 0,
        lineIndexes: [],
        problem: `${before.disconnectedSwitches} disconnected speaker switches; responsive ratio ${(before.responsiveSwitchRatio * 100).toFixed(0)}%; strict alternation ${(before.strictAlternationRatio * 100).toFixed(0)}%.`,
        repairInstruction: "Make each turn answer the preceding thought; add same-speaker builds and remove parallel monologues.",
      }],
    };

    for (let round = 1; round <= maxRounds; round++) {
      rounds = round;
      const payload = await rewriteConversation(options.rewriteLlm, segments, currentReview, options.hostNames);
      const applied = applyRewrites(segments, payload);
      segments = applied.segments;
      rewrittenLines += applied.rewrittenLines;
      after = scoreConversationContinuity(segments);

      try {
        semanticAfter = await semanticReview(options.reviewLlm, segments, options.hostNames);
        currentReview = semanticAfter;
      } catch (error) {
        reasons.push(`Semantic re-review round ${round} failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      const passed = deterministicPass(after, minDeterministicScore) &&
        (!semanticAfter || (semanticAfter.pass && semanticAfter.score >= minSemanticScore));
      options.log?.(`Conversation director round ${round}: deterministic ${after.score}/100, semantic ${semanticAfter?.score ?? "n/a"}/100, pass=${passed}.`);
      if (passed) break;
    }
  }

  after = scoreConversationContinuity(segments);
  const passed = deterministicPass(after, minDeterministicScore) &&
    (!semanticAfter
      ? (!semanticBefore || (semanticBefore.pass && semanticBefore.score >= minSemanticScore))
      : (semanticAfter.pass && semanticAfter.score >= minSemanticScore));

  reasons.push(
    `Conversation continuity: ${before.score}/100 → ${after.score}/100; ` +
    `responsive switches ${(before.responsiveSwitchRatio * 100).toFixed(0)}% → ${(after.responsiveSwitchRatio * 100).toFixed(0)}%; ` +
    `disconnected ${before.disconnectedSwitches} → ${after.disconnectedSwitches}; ` +
    `semantic ${semanticBefore?.score ?? "n/a"} → ${semanticAfter?.score ?? semanticBefore?.score ?? "n/a"}.`
  );

  if (!passed && strict) {
    throw new Error(
      `Conversation quality gate failed after ${rounds} rewrite round(s): deterministic ${after.score}/100 ` +
      `(minimum ${minDeterministicScore}), semantic ${semanticAfter?.score ?? semanticBefore?.score ?? "not available"}/100 ` +
      `(minimum ${minSemanticScore}), ${after.disconnectedSwitches} disconnected speaker switch(es), ` +
      `${after.unansweredQuestions} unanswered question(s). The script was NOT saved.`
    );
  }

  return {
    segments,
    report: {
      strict,
      rounds,
      rewrittenLines,
      before,
      after,
      semanticBefore,
      semanticAfter,
      passed,
      reasons,
    },
  };
}
