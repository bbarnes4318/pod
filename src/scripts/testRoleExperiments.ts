// Targeted ROLE experiments. Run:
//
//   npm run test:role-experiments                        # all three, live
//   npm run test:role-experiments -- --experiment dialogue
//   npm run test:role-experiments -- --experiment outline
//   npm run test:role-experiments -- --experiment verification
//   npm run test:role-experiments -- --dry-run           # no API calls at all
//
// This is NOT "two arbitrary models across the whole pipeline". Each experiment
// isolates ONE role and gives every candidate byte-identical inputs, because a
// comparison where the inputs differ tells you nothing:
//
//   dialogue      same research packet, outline, character prompt, previous
//                 movement context, target length, prompt, schema, token
//                 allowance — only the model changes.
//   outline       same evidence and episode requirements.
//   verification  the same seeded defect set, with ground truth, so false
//                 positives and false negatives are both measurable.
//
// HONESTY RULES BUILT IN:
//   - a candidate with no credential is reported SKIPPED, never as a low score;
//   - an incomplete or failed generation is reported as a FAILURE with its
//     error, never quietly retried into a win or dropped from the table;
//   - the deterministic scorer is used as-is and is never re-tuned here;
//   - the LLM judge is a separate column from the deterministic score, so you
//     can see when they disagree.

import fs from "fs";
import path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.join(process.cwd(), ".env.coolify.local") });
dotenv.config();

import { LLMProvider } from "../lib/providers/llm/interface";
import { instantiateProvider, providerCredentialPresent, resolveLegacyFamily } from "../lib/providers/llm/routing";
import { MODEL_IDS } from "../lib/providers/llm/capabilities";
import { generateOutlineDrivenScript } from "../lib/services/scriptOutlineEngine";
import { assessScriptQuality } from "../lib/services/scriptQualityJudge";
import { dedupeScriptSegments, normalizeLineIndexes, findRepetitions } from "../lib/services/scriptRepetition";
import { runSemanticReview } from "../lib/services/semanticReview";

// ---------------------------------------------------------------- CLI

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const DRY_RUN = argv.includes("--dry-run");
const WHICH = (flag("experiment") || "all").toLowerCase();
const OUT_DIR = path.join(process.cwd(), "samples");

let failures = 0;

// ---------------------------------------------------------------- candidates

interface Candidate {
  label: string;
  provider: string;
  model?: string;
}

const nv = (model: string): Candidate => ({ label: `nvidia/${model}`, provider: "nvidia", model });
const zaiFlash = (): Candidate => ({
  label: `zai/${MODEL_IDS.zai.glmFlash}`,
  provider: "zai",
  model: MODEL_IDS.zai.glmFlash,
});

/** The CURRENT model for a legacy family — the incumbent every candidate must beat. */
function incumbent(family: "script" | "verify"): Candidate {
  const cfg = resolveLegacyFamily(family);
  return {
    label: `${cfg.provider}/${cfg.model ?? "(provider default)"} [incumbent]`,
    provider: cfg.provider,
    model: cfg.model,
  };
}

const DIALOGUE_CANDIDATES = (): Candidate[] => [
  nv(MODEL_IDS.nvidia.mistral),
  nv(MODEL_IDS.nvidia.kimi),
  zaiFlash(),
  incumbent("script"),
];

const OUTLINE_CANDIDATES = (): Candidate[] => [
  nv(MODEL_IDS.nvidia.glm),
  nv(MODEL_IDS.nvidia.nemotron),
  zaiFlash(),
  incumbent("script"),
];

const VERIFICATION_CANDIDATES = (): Candidate[] => [
  nv(MODEL_IDS.nvidia.deepseekPro),
  nv(MODEL_IDS.nvidia.nemotron),
  zaiFlash(),
  incumbent("verify"),
];

interface Resolved {
  candidate: Candidate;
  provider: LLMProvider | null;
  skipReason?: string;
}

function resolveCandidates(candidates: Candidate[]): Resolved[] {
  return candidates.map((candidate) => {
    if (DRY_RUN) return { candidate, provider: null, skipReason: "--dry-run" };
    if (candidate.provider === "stub") {
      return { candidate, provider: null, skipReason: "resolves to stub — nothing to measure" };
    }
    if (!providerCredentialPresent(candidate.provider)) {
      return { candidate, provider: null, skipReason: `no credential for ${candidate.provider}` };
    }
    try {
      return { candidate, provider: instantiateProvider(candidate.provider, candidate.model) };
    } catch (err: any) {
      return { candidate, provider: null, skipReason: err?.message || String(err) };
    }
  });
}

// ---------------------------------------------------------------- shared inputs

/**
 * The FIXED experiment packet. Checked into the repo as a fixture rather than
 * fetched live, because a live fetch would hand each run different source
 * material and make two runs incomparable. Live-material runs belong in
 * `npm run test:model-ab`, which exists for that.
 */
const PERSONA_PROMPT = `You are writing dialogue for "Take Machine", a two-host sports debate podcast.

ZABALA — Bernadette "Line Two" Zabala. Former talk-radio call screener. Structural, procedural, keeps receipts, distrusts narrative. Speaks in short declaratives and asks one precise question too many. Never raises her voice; lands the knife quietly.

MULKEY — Dutch "Attendance" Mulkey. Ex-minor-league promotions guy. Sentimental, anecdotal, inflates his own numbers, changes the subject when cornered. Long looping sentences, sudden specificity when he is telling the truth.

HOW REAL PODCAST SPEECH WORKS
Write spoken language, not prose. No greetings, no episode summary, no signposting.`;

const EVIDENCE_PACKET = `
Topic #1: Should a 3-1 team fire the coordinator who built its only losing quarter?
Sport/League: Football / NFL
Main Angle: The Ridgeline Foxes are 3-1 but their defense allowed 24 points in the fourth quarter of Week 4 alone.
Why It Matters RIGHT NOW: Ownership meets Thursday; the coordinator's contract has a Friday option date.
Strongest Debate Question: Does one collapsed quarter justify firing the person who built four winning ones?
Zabala Debate Stance: Process over outcome — the fourth-quarter scheme was identical to the three that worked; the sample is one quarter.
Mulkey Debate Stance: Perception is the product — a fanbase that watched a 17-point lead die does not care about sample size.
Key Grounded Facts: [
  {"text":"Ridgeline is 3-1 after four games.","evidenceRefs":[{"type":"newsItem","id":"news-1"}],"confidence":"high"},
  {"text":"Ridgeline allowed 24 points in the fourth quarter of Week 4.","evidenceRefs":[{"type":"newsItem","id":"news-1"}],"confidence":"high"},
  {"text":"Coordinator Ray Aldana has a contract option that must be exercised Friday.","evidenceRefs":[{"type":"newsItem","id":"news-2"}],"confidence":"high"},
  {"text":"Ridgeline led 24-7 entering the fourth quarter of Week 4.","evidenceRefs":[{"type":"newsItem","id":"news-1"}],"confidence":"high"},
  {"text":"Aldana's units ranked 6th in points allowed over the prior two seasons.","evidenceRefs":[{"type":"newsItem","id":"news-2"}],"confidence":"medium"},
  {"text":"Ownership scheduled a football-operations meeting for Thursday.","evidenceRefs":[{"type":"newsItem","id":"news-2"}],"confidence":"high"}
]
On-Air Talking Points: [{"text":"A 17-point fourth-quarter lead evaporated in twelve minutes.","evidenceRefs":[{"type":"newsItem","id":"news-1"}]}]
Suggested Counter-arguments: [{"host":"Zabala","claim":"One quarter is not a body of evidence."},{"host":"Mulkey","claim":"The option date, not the film, is what forces this."}]
Unsafe Claims (DO NOT USE AS FACTS OR TRUTHS): ["Aldana has already been told he is being let go."]
`;

const EPISODE_TITLE = "Role experiment — the Aldana option";
const HOST_NAMES = ["Zabala", "Mulkey"];

// ---------------------------------------------------------------- reporting

function table(rows: Record<string, string | number>[], columns: string[]): void {
  const widths = columns.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length))
  );
  const line = (cells: (string | number)[]) =>
    cells.map((cell, i) => String(cell ?? "").padEnd(widths[i])).join("  ");
  console.log(line(columns));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(columns.map((c) => r[c] ?? "")));
}

function writeArtifact(name: string, data: unknown): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const p = path.join(OUT_DIR, name);
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  console.log(`\n  artifact: ${p}`);
}

// ---------------------------------------------------------------- dialogue

async function dialogueExperiment(): Promise<void> {
  console.log("\n=== DIALOGUE EXPERIMENT (role: script_movement) ===");
  console.log("Identical outline, evidence, character prompt, word target and 16,000-token allowance for every candidate.\n");

  const resolved = resolveCandidates(DIALOGUE_CANDIDATES());
  // One outline model for ALL candidates, so the dialogue comparison is not
  // contaminated by different episode plans.
  const outlineHost = resolved.find((r) => r.provider);
  const rows: Record<string, string | number>[] = [];
  const artifacts: unknown[] = [];

  const judgeCandidate = resolved.find(
    (r) => r.provider && r.candidate.provider === "nvidia" && r.candidate.model === MODEL_IDS.nvidia.nemotron
  );
  const judge = judgeCandidate?.provider ?? null;

  for (const r of resolved) {
    if (!r.provider) {
      rows.push({ candidate: r.candidate.label, status: `SKIPPED (${r.skipReason})`, lines: "—", words: "—", rep: "—", det: "—", judge: "—", secs: "—" });
      continue;
    }
    const startedAt = Date.now();
    try {
      const out = await generateOutlineDrivenScript(r.provider, {
        systemPrompt: PERSONA_PROMPT,
        episodeTitle: EPISODE_TITLE,
        topicsPrompts: EVIDENCE_PACKET,
        targetDuration: 10,
        version: 1,
        temperature: 0.85,
        // The production allowance, unchanged. A candidate that cannot honor it
        // is a finding, not something to work around.
        maxTokens: 16000,
        speakerNames: HOST_NAMES,
        // Same outline model for everyone.
        outlineLlm: outlineHost?.provider ?? r.provider,
        log: () => {},
      });
      const { segments } = dedupeScriptSegments(out.segments);
      normalizeLineIndexes(segments);
      const texts: string[] = [];
      for (const seg of segments) for (const l of seg.lines || []) texts.push(String(l.text || ""));
      const rep = findRepetitions(texts);
      const assessed = await assessScriptQuality(
        // Never let a candidate judge itself.
        judge && judge !== r.provider ? judge : null,
        segments,
        { episodeTitle: EPISODE_TITLE, hostNames: HOST_NAMES, evidenceSummary: EVIDENCE_PACKET }
      );
      rows.push({
        candidate: r.candidate.label,
        status: "ok",
        lines: assessed.lineCount,
        words: assessed.wordCount,
        rep: `${(rep.repetitionRatio * 100).toFixed(1)}%`,
        det: `${assessed.deterministic.total}/100`,
        judge: assessed.judge ? `${assessed.judge.overall}/100${assessed.judge.bothHostsSoundLikeOneModel ? " ONE-VOICE" : ""}` : `n/a (${assessed.judgeError ?? "no judge"})`,
        secs: ((Date.now() - startedAt) / 1000).toFixed(0),
      });
      artifacts.push({ candidate: r.candidate.label, segments, assessment: assessed });
    } catch (err: any) {
      failures++;
      rows.push({
        candidate: r.candidate.label,
        status: `FAILED: ${(err?.message || String(err)).slice(0, 90)}`,
        lines: 0,
        words: 0,
        rep: "—",
        det: "—",
        judge: "—",
        secs: ((Date.now() - startedAt) / 1000).toFixed(0),
      });
      artifacts.push({ candidate: r.candidate.label, error: err?.message || String(err) });
    }
  }

  table(rows, ["candidate", "status", "lines", "words", "rep", "det", "judge", "secs"]);
  writeArtifact("role-experiment-dialogue.json", { experiment: "dialogue", rows, artifacts });
}

// ---------------------------------------------------------------- outline

const OUTLINE_PROMPT = `You are showrunning episode "${EPISODE_TITLE}" (roughly 10 minutes).

TOPICS & EVIDENCE:
${EVIDENCE_PACKET}

Build a SMALL story spine, not a rundown checklist. Use 6 to 8 beats. Beat 1 is a cold open already in motion; the final beat is a closing payoff. Organize around ONE unresolved central question. Every beat must change something. Plan at least one genuine position shift. Assign each evidence fact to at most one beat.

Return valid JSON only:
{ "beats": [ { "beatIndex": 0, "segmentType": "cold_open|intro|topic|transition|closing", "title": "...", "goal": "what changes", "angle": "specific pressure/question", "factRefs": [], "escalation": "...", "callback": "optional" } ] }`;

async function outlineExperiment(): Promise<void> {
  console.log("\n=== OUTLINE EXPERIMENT (role: script_outline) ===");
  console.log("Same evidence and episode requirements for every candidate; 7,000-token outline allowance.\n");

  const resolved = resolveCandidates(OUTLINE_CANDIDATES());
  const rows: Record<string, string | number>[] = [];
  const artifacts: unknown[] = [];

  for (const r of resolved) {
    if (!r.provider) {
      rows.push({ candidate: r.candidate.label, status: `SKIPPED (${r.skipReason})`, beats: "—", facts: "—", dupFacts: "—", shifts: "—", coldOpen: "—", payoff: "—", secs: "—" });
      continue;
    }
    const startedAt = Date.now();
    try {
      const res = await r.provider.generateStructuredOutput<any>({
        prompt: OUTLINE_PROMPT,
        systemPrompt: PERSONA_PROMPT,
        temperature: 0.7,
        maxTokens: 7000,
        reasoning: "on",
        validate: (v) =>
          Array.isArray((v as { beats?: unknown })?.beats) ? null : "Outline is missing the required 'beats' array.",
      });
      const beats: any[] = Array.isArray(res?.beats) ? res.beats : [];
      // Structural measures only — no rubric invented to favor any candidate.
      const refKeys = beats.flatMap((b) =>
        (Array.isArray(b?.factRefs) ? b.factRefs : []).map((f: any) => `${f?.type}:${f?.id}`)
      );
      const dupFacts = refKeys.length - new Set(refKeys).size;
      const shifts = beats.filter((b) => /shift|change|concede|admit|reverse/i.test(`${b?.goal} ${b?.escalation}`)).length;
      rows.push({
        candidate: r.candidate.label,
        status: beats.length >= 5 ? "ok" : `INCOMPLETE (${beats.length} beats, 5 required)`,
        beats: beats.length,
        facts: new Set(refKeys).size,
        dupFacts,
        shifts,
        coldOpen: beats[0]?.segmentType === "cold_open" ? "yes" : "no",
        payoff: beats[beats.length - 1]?.segmentType === "closing" ? "yes" : "no",
        secs: ((Date.now() - startedAt) / 1000).toFixed(0),
      });
      if (beats.length < 5) failures++;
      artifacts.push({ candidate: r.candidate.label, beats });
    } catch (err: any) {
      failures++;
      rows.push({
        candidate: r.candidate.label,
        status: `FAILED: ${(err?.message || String(err)).slice(0, 90)}`,
        beats: 0, facts: "—", dupFacts: "—", shifts: "—", coldOpen: "—", payoff: "—",
        secs: ((Date.now() - startedAt) / 1000).toFixed(0),
      });
      artifacts.push({ candidate: r.candidate.label, error: err?.message || String(err) });
    }
  }

  table(rows, ["candidate", "status", "beats", "facts", "dupFacts", "shifts", "coldOpen", "payoff", "secs"]);
  writeArtifact("role-experiment-outline.json", { experiment: "outline", rows, artifacts });
}

// ---------------------------------------------------------------- verification

/**
 * SEEDED DEFECT SET with ground truth. `shouldFlag: true` lines contain a real
 * problem; `shouldFlag: false` lines are legitimate speech that a trigger-happy
 * verifier wrongly fails. Both directions matter: a checker that flags
 * everything is as useless as one that flags nothing.
 */
const SEEDED_LINES: {
  lineIndex: number;
  speakerName: string;
  text: string;
  isFactualClaim: boolean;
  tone: string;
  shouldFlag: boolean;
  defect: string;
}[] = [
  { lineIndex: 0, speakerName: "Zabala", text: "They're 3-1. That's the whole record, four games.", isFactualClaim: true, tone: "analytical", shouldFlag: false, defect: "supported fact" },
  { lineIndex: 1, speakerName: "Mulkey", text: "Aldana's units finished second in points allowed two years running.", isFactualClaim: true, tone: "incredulous", shouldFlag: true, defect: "UNSUPPORTED number — evidence says 6th, not 2nd" },
  { lineIndex: 2, speakerName: "Zabala", text: "Twenty-four points in one quarter after leading 24-7.", isFactualClaim: true, tone: "analytical", shouldFlag: false, defect: "supported fact" },
  { lineIndex: 3, speakerName: "Mulkey", text: "I think they keep him, and I think it costs them the division.", isFactualClaim: false, tone: "reflective", shouldFlag: false, defect: "OPINION / prediction — must not be failed as a factual error" },
  { lineIndex: 4, speakerName: "Zabala", text: "If the option date weren't Friday nobody would be having this conversation.", isFactualClaim: false, tone: "dismissive", shouldFlag: false, defect: "REASONABLE INFERENCE from a supported fact" },
  { lineIndex: 5, speakerName: "Mulkey", text: "Sources tell me he's already been informed he's gone.", isFactualClaim: true, tone: "excited", shouldFlag: true, defect: "UNSAFE claim — explicitly listed as unusable" },
  { lineIndex: 6, speakerName: "Zabala", text: "They're 2-2, which is exactly the problem.", isFactualClaim: true, tone: "analytical", shouldFlag: true, defect: "CONTRADICTION — contradicts line 0 and the evidence" },
  { lineIndex: 7, speakerName: "Mulkey", text: "Twenty-four points in one quarter after leading 24-7. That's the whole story.", isFactualClaim: true, tone: "heated", shouldFlag: true, defect: "REPETITION of line 2, verbatim" },
  { lineIndex: 8, speakerName: "Zabala", text: "Honestly I don't care about the process, just fire somebody and let's move on.", isFactualClaim: false, tone: "dismissive", shouldFlag: true, defect: "CHARACTER VIOLATION — Zabala is the process host" },
  { lineIndex: 9, speakerName: "Mulkey", text: "Ownership meets Thursday, so the film has one more week to matter.", isFactualClaim: true, tone: "setup", shouldFlag: true, defect: "CONTINUITY ERROR — Thursday precedes the Friday option date, so there is no extra week" },
];

const EVIDENCE_PANEL = [
  "news-1: Ridgeline is 3-1 after four games. Ridgeline allowed 24 points in the fourth quarter of Week 4 after leading 24-7 entering it.",
  "news-2: Coordinator Ray Aldana has a contract option that must be exercised Friday. Aldana's units ranked 6th in points allowed over the prior two seasons. Ownership scheduled a football-operations meeting for Thursday.",
];

async function verificationExperiment(): Promise<void> {
  console.log("\n=== VERIFICATION EXPERIMENT (roles: script_verification / fact_check) ===");
  console.log(`Seeded set: ${SEEDED_LINES.length} lines, ${SEEDED_LINES.filter((l) => l.shouldFlag).length} genuinely defective, ${SEEDED_LINES.filter((l) => !l.shouldFlag).length} legitimate.\n`);

  const resolved = resolveCandidates(VERIFICATION_CANDIDATES());
  const rows: Record<string, string | number>[] = [];
  const artifacts: unknown[] = [];

  for (const r of resolved) {
    if (!r.provider) {
      rows.push({ candidate: r.candidate.label, status: `SKIPPED (${r.skipReason})`, caught: "—", missed: "—", falsePos: "—", precision: "—", recall: "—", secs: "—" });
      continue;
    }
    const startedAt = Date.now();
    try {
      const result = await runSemanticReview(r.provider, {
        reviewLines: SEEDED_LINES.map((l) => ({
          lineIndex: l.lineIndex,
          speakerName: l.speakerName,
          text: l.text,
          isFactualClaim: l.isFactualClaim,
          tone: l.tone,
          isInterruption: false,
          isFragment: false,
        })),
        evidencePanelItems: EVIDENCE_PANEL,
        unsafeClaims: ["Aldana has already been told he is being let go."],
        rumorKeywords: ["sources tell me", "sources say", "i'm hearing"],
      });

      const flagged = new Set<number>();
      for (const lr of Array.isArray(result?.lineResults) ? result.lineResults : []) {
        if (lr?.status === "unsupported" || lr?.status === "needs_review") flagged.add(Number(lr.lineIndex));
      }
      const truePos = SEEDED_LINES.filter((l) => l.shouldFlag && flagged.has(l.lineIndex));
      const falseNeg = SEEDED_LINES.filter((l) => l.shouldFlag && !flagged.has(l.lineIndex));
      const falsePos = SEEDED_LINES.filter((l) => !l.shouldFlag && flagged.has(l.lineIndex));
      const precision = truePos.length + falsePos.length > 0 ? truePos.length / (truePos.length + falsePos.length) : 0;
      const recall = truePos.length / SEEDED_LINES.filter((l) => l.shouldFlag).length;

      rows.push({
        candidate: r.candidate.label,
        status: "ok",
        caught: truePos.length,
        missed: falseNeg.length,
        falsePos: falsePos.length,
        precision: `${(precision * 100).toFixed(0)}%`,
        recall: `${(recall * 100).toFixed(0)}%`,
        secs: ((Date.now() - startedAt) / 1000).toFixed(0),
      });
      artifacts.push({
        candidate: r.candidate.label,
        missed: falseNeg.map((l) => ({ line: l.lineIndex, defect: l.defect })),
        falsePositives: falsePos.map((l) => ({ line: l.lineIndex, why: l.defect })),
        raw: result,
      });
    } catch (err: any) {
      failures++;
      rows.push({
        candidate: r.candidate.label,
        status: `FAILED: ${(err?.message || String(err)).slice(0, 90)}`,
        caught: 0, missed: "—", falsePos: "—", precision: "—", recall: "—",
        secs: ((Date.now() - startedAt) / 1000).toFixed(0),
      });
      artifacts.push({ candidate: r.candidate.label, error: err?.message || String(err) });
    }
  }

  table(rows, ["candidate", "status", "caught", "missed", "falsePos", "precision", "recall", "secs"]);
  console.log("\n  Ground truth (what a good verifier must catch):");
  for (const l of SEEDED_LINES.filter((x) => x.shouldFlag)) console.log(`    line ${l.lineIndex}: ${l.defect}`);
  console.log("  Must NOT be flagged:");
  for (const l of SEEDED_LINES.filter((x) => !x.shouldFlag)) console.log(`    line ${l.lineIndex}: ${l.defect}`);
  writeArtifact("role-experiment-verification.json", { experiment: "verification", rows, artifacts, groundTruth: SEEDED_LINES });
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  console.log("Role experiments — one role at a time, identical inputs per candidate.");
  if (DRY_RUN) {
    console.log("\n--dry-run: no API calls. Every candidate is reported SKIPPED. This verifies the harness wiring only.");
  }

  if (WHICH === "all" || WHICH === "dialogue") await dialogueExperiment();
  if (WHICH === "all" || WHICH === "outline") await outlineExperiment();
  if (WHICH === "all" || WHICH === "verification") await verificationExperiment();

  console.log(
    `\n${failures} candidate run(s) failed or came back incomplete. ` +
      `A failure here is a RESULT — it means that model could not do this role's job on this application's real work.`
  );
  console.log(
    "PROMOTION RULE: keep the current assignment unless a candidate completes the required JSON reliably, honors the\n" +
      "required output length, matches or beats the incumbent on role-specific quality, adds no unacceptable latency, and\n" +
      "does not raise retry/fallback rates. Document any change in src/lib/providers/llm/profiles.ts with the evidence."
  );
}

main().catch((err) => {
  console.error("Role experiments failed to run:", err);
  process.exit(1);
});
