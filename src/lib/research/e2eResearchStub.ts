// E2E-ONLY research generator stub.
//
// Lets the Playwright harness drive the REAL grounded-research path — real
// validation, real promotion, real database — without an LLM, a research
// provider, or a network call. It replaces exactly one thing: the model's
// output. Everything downstream of it runs for real, which is the point: a test
// that also stubbed the validator would prove nothing about grounding.
//
// SAFETY: inert unless E2E_TEST_MODE=1 (set only on the dev server the harness
// spawns, never in production). Every entry point re-checks the flag, so this
// cannot be reached by a normal deployment even if the route were somehow hit.
// It weakens NO authorization — requireAdmin() still gates every action — and
// bypasses NO evidence validation: the payloads below go through
// validateBriefResult and promoteCitedSources exactly like a real model's would,
// which is how the "cites the topic itself" and "cites a foreign source" cases
// get genuinely rejected rather than merely asserted.

import { e2eEnabled } from "../e2eSeam";

/** What the stub should return for the next research run of a given topic. */
export type E2EResearchMode =
  | "grounded"        // cites the topic's real TopicSource -> should be accepted
  | "topic_self"      // cites the TopicCandidate's own id -> must be rejected
  | "foreign_source"  // cites another topic's TopicSource -> must be rejected
  | "ungrounded";     // claims with no refs at all -> must be rejected

interface Armed {
  mode: E2EResearchMode;
  /** For foreign_source: the id to cite. */
  foreignSourceId?: string;
}

// Next bundles route handlers and server actions separately, so module scope is
// not shared between them. Hang state off globalThis, the same pattern this repo
// already uses for its Prisma/Redis singletons and the startDebate seam.
const g = globalThis as unknown as { __podE2EResearch?: Map<string, Armed> };
const store = (): Map<string, Armed> => (g.__podE2EResearch ??= new Map());

/** Arm the stub for one topic. No-op outside E2E mode. */
export function armE2EResearch(topicId: string, mode: E2EResearchMode, foreignSourceId?: string): boolean {
  if (!e2eEnabled()) return false;
  store().set(topicId, { mode, foreignSourceId });
  return true;
}

export function disarmE2EResearch(topicId: string): void {
  if (!e2eEnabled()) return;
  store().delete(topicId);
}

/** Is the stub armed for this topic right now? */
export function e2eResearchArmed(topicId: string): boolean {
  return e2eEnabled() && store().has(topicId);
}

const FACT = "The wire report gives the team seven wins in nine games since the change, with the exact dates listed.";
const POINT = "That is the best nine-game stretch any team in the division has managed this season.";

/**
 * The stubbed generator output, shaped exactly like the real LLM's JSON so the
 * validator cannot tell the difference. `sources` is the topic's OWN usable
 * TopicSource ids, as the caller resolved them from the database — the stub
 * cites a REAL persisted id, not a fabricated one.
 */
export function e2eResearchResult(
  topicId: string,
  sources: string[],
  hostAName: string,
  hostBName: string
): Record<string, unknown> | null {
  if (!e2eEnabled()) return null;
  const armed = store().get(topicId);
  if (!armed) return null;

  const cite = (() => {
    switch (armed.mode) {
      case "grounded": return sources[0] ? [{ type: "topicSource", id: sources[0] }] : [];
      // The id of the topic being researched. The validator must refuse this
      // however it arrives — by type or by id.
      case "topic_self": return [{ type: "topicSource", id: topicId }];
      // A real TopicSource row that belongs to a DIFFERENT topic.
      case "foreign_source": return [{ type: "topicSource", id: armed.foreignSourceId ?? "no-such-source" }];
      case "ungrounded": return [];
    }
  })();

  return {
    classification: "news_reaction",
    mainAngle: "Whether the turnaround is real",
    whyMattersNow: "It decides the division",
    keyFactsContext: [{ text: FACT, evidenceRefs: cite, confidence: "high" }],
    onAirTalkingPoints: [{ text: POINT, evidenceRefs: cite }],
    contrarianAngle: "The schedule was soft",
    strongestDebateQuestion: "Is it the coaching or the calendar?",
    suggestedHostTake: "Give it three more games",
    argumentForHostA: "The record since the change speaks for itself.",
    argumentForHostAEvidenceRefs: cite,
    argumentForHostB: "Nine games against that schedule proves nothing.",
    argumentForHostBEvidenceRefs: cite,
    counterArguments: [{ host: hostAName, claim: "The underlying numbers moved too.", evidenceRefs: cite }],
    unsafeClaims: [],
    sourceIds: cite,
    _e2eHosts: [hostAName, hostBName],
  };
}
