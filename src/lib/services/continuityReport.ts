// Extracting the continuity claim from a finished script.
//
// HARD REQUIREMENT: a missing or malformed continuity report must NEVER fail
// episode generation. The continuity engine is a feature layered on top of the
// show; it is not allowed to become a new way for an episode to die. Every
// failure path here — provider error, timeout, unparseable JSON, schema
// violation, garbage values — logs and returns null. Absent means "no
// continuity moved this episode", not an outage.
//
// This is a SEPARATE call rather than a field on the script's structured
// output, deliberately. The script is generated act-by-act with retries and a
// single-shot fallback; adding a continuity field to that schema would put it
// inside the retry machinery and give a malformed continuity value the power to
// trigger a script regeneration. A standalone report has exactly one failure
// mode — it returns null — and the episode is untouched.
//
// The trust boundary is unchanged: the model REPORTS what it wrote, in flags,
// bounded counts, and values from closed lists. continuityUpdateSchema remains
// the single validation point, and nextContinuityState decides what any of it
// means for state.

import type { LLMProvider } from "../providers/llm/interface";
import { withLlmStage } from "../providers/llm/costLedger";
import { continuityUpdateSchema, type ContinuityUpdate } from "./showContinuityService";
import { LEDGER_PHRASES, type ContinuityOpportunities } from "./showContinuity";

export interface ContinuityReportInput {
  /** The finished dialogue, speaker-prefixed, one line per line. */
  scriptText: string;
  /** What this episode was OFFERED — the closed lists. */
  opportunities: ContinuityOpportunities;
  log?: (msg: string) => void;
}

function buildReportPrompt(input: ContinuityReportInput): string {
  const o = input.opportunities;
  const knownPhrases = o.languageLedger.entries.map((e) => e.phrase);
  return [
    "Below is a finished episode of a sports-talk show. Report ONLY what actually happened in it.",
    "",
    "You are not writing anything. You are not deciding anything. You are reading a transcript and",
    "filling in a form about it. If something did not happen, say it did not happen — a false report",
    "is far worse than a negative one, because it silently corrupts the show's running continuity.",
    "MOST EPISODES MOVE LITTLE OR NOTHING. An all-negative report is a completely normal answer and",
    "is much better than a generous one.",
    "",
    "The two hosts are Zabala (the outsider, the paying customer's prosecutor) and Cal Mercer (the",
    "former advance scout who spent years inside organizations).",
    "",
    "RULES:",
    '- "redEyeLayerDelivered": true ONLY if Cal actually admitted something new about his own past —',
    "  specifically about having helped an organization turn its failure into a story about a person.",
    "  A general reference to having been inside, or to having seen this before, is NOT a layer.",
    o.redEye.eligible
      ? `  The layer this episode was offered: ${o.redEye.layer}`
      : "  No layer was offered this episode, so this is almost certainly false.",
    '- "redEyeDisclosure": if and only if the above is true, the NEW thing he admitted, in one sentence.',
    '- "languageUsed": institutional phrases Cal reached for, with what he was covering. Only phrases he',
    `  actually said. Typical examples: ${LEDGER_PHRASES.slice(0, 6).join(", ")}. Empty if none.`,
    '- "languageResolved": phrases he explicitly took back ("rejected") or rewrote into a truer sentence',
    '  ("revised") during this episode. Empty if none.',
    knownPhrases.length
      ? `- "languageRecalled": a phrase Zabala threw back at him from a PRIOR episode, exactly one of: ${knownPhrases.join(" | ")}. null if none.`
      : '- "languageRecalled": null (nothing is on record yet).',
    '- "positionsTaken": positions either host actually argued that a later episode could hold them to.',
    '  Use host "cal" or "zabala", a short topicKey naming the subject, and one sentence for the position.',
    '- "positionRecalled": a position from a PRIOR episode that either host brought back. null if none.',
    '- "relationship": how the episode left them. "trustDelta" -2..2 (0 is normal).',
    '  "calDisclosed" true if he gave up something he did not have to. "calRationalized" true if he hid',
    "  behind process language. \"zabalaOverreached\" true if she flattened a complicated situation.",
    '  "positionChangedBy" is who genuinely MOVED — "cal", "zabala", or "none". "openThread" is any',
    "  interpersonal question left hanging, or null.",
    "",
    "Return ONLY this JSON object, with no commentary:",
    "{",
    '  "redEyeLayerDelivered": boolean, "redEyeDisclosure": string|null,',
    '  "languageUsed": [ { "phrase": "...", "context": "..." } ],',
    '  "languageResolved": [ { "phrase": "...", "resolution": "rejected"|"revised" } ],',
    '  "languageRecalled": string|null,',
    '  "positionsTaken": [ { "host": "cal"|"zabala", "topicKey": "...", "position": "..." } ],',
    '  "positionRecalled": { "host": "cal"|"zabala", "position": "..." }|null,',
    '  "relationship": { "trustDelta": 0, "calDisclosed": false, "calRationalized": false,',
    '                    "zabalaOverreached": false, "positionChangedBy": "none", "openThread": null }',
    "}",
    "",
    "=== EPISODE ===",
    input.scriptText,
  ].join("\n");
}

/**
 * Ask the model what its own episode did. Returns null on ANY failure.
 *
 * Never throws. Callers do not need a try/catch, and must not treat null as an
 * error condition — it means "nothing to record".
 */
export async function reportContinuityClaim(
  llm: LLMProvider,
  input: ContinuityReportInput
): Promise<ContinuityUpdate | null> {
  const log = input.log ?? (() => {});
  try {
    const raw = await withLlmStage("continuity:report", () =>
      llm.generateStructuredOutput<unknown>({
        prompt: buildReportPrompt(input),
        systemPrompt:
          "You are a precise transcript auditor. You report only what is literally present in the text you are given. " +
          "You never infer, never embellish, and never report something as having happened because it was supposed to.",
        temperature: 0,
        maxTokens: 1200,
      })
    );

    // A response that is not an object at all is a TOTAL failure, not a
    // partial one. Salvaging it would yield an all-defaults claim — a claim the
    // model never made, recorded as though it had.
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      log("Continuity report discarded — the provider did not return an object.");
      console.warn("[Continuity] Report was not an object; the episode is unaffected.");
      return null;
    }

    const parsed = continuityUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      // Salvage attempt: drop the offending keys and re-parse with defaults, so
      // one bad field does not discard an otherwise-good report. Still never
      // throws, and still validated by the same schema.
      const salvaged = salvage(raw, parsed.error.issues.map((i) => String(i.path[0])));
      const retry = continuityUpdateSchema.safeParse(salvaged);
      if (retry.success) {
        log(
          `Continuity report: ${parsed.error.issues.length} invalid field(s) dropped ` +
            `(${[...new Set(parsed.error.issues.map((i) => i.path.join(".")))].join(", ")}); the rest was kept.`
        );
        return retry.data;
      }
      log(`Continuity report discarded — did not validate: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      console.warn("[Continuity] Report failed validation and could not be salvaged; the episode is unaffected.", parsed.error.issues);
      return null;
    }
    return parsed.data;
  } catch (err) {
    // Provider error, timeout, non-JSON response — all the same non-event.
    log(`Continuity report unavailable (${err instanceof Error ? err.message : String(err)}); episode generated without it.`);
    console.warn(
      `[Continuity] Report call failed; the episode is unaffected and no continuity will be recorded for it. ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/** Remove the named top-level keys so schema defaults can fill them in. */
function salvage(raw: unknown, badKeys: string[]): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const copy: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const k of badKeys) delete copy[k];
  // `.strict()` rejects unknown keys, so anything the schema does not know
  // about is dropped here too rather than failing the whole report.
  const known = new Set(Object.keys(continuityUpdateSchema.shape));
  for (const k of Object.keys(copy)) if (!known.has(k)) delete copy[k];
  return copy;
}
