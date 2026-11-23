// Which kind of show the shared creative pipeline is writing.
//
// The seven-role writing pipeline (story editor → debate architect → one writer
// per host → dialogue director → continuity → judge) is what makes sports
// episodes sound like two real people. Business episodes used to bypass all of
// it with one LLM call and came out sounding like "robots from the 1940s"
// (owner, Milestone 2). The pipeline is evidence-agnostic except for a handful
// of prompt sentences written for sports ("the team and the player", "a fan who
// did not watch the game"). Rather than thread a parameter through every stage,
// the business caller runs the pipeline inside withCreativeDomain(); those few
// sentences read the domain and switch wording. With no domain set — every
// sports call — every prompt is byte-identical to before.

import { AsyncLocalStorage } from "node:async_hooks";

export interface CreativeDomain {
  kind: "business";
  /** e.g. "Telecommunications — wholesale VoIP termination" */
  industry: string;
  /** e.g. "contact center operators, wholesale carriers" */
  audience: string;
}

const store = new AsyncLocalStorage<CreativeDomain>();

export function withCreativeDomain<T>(domain: CreativeDomain, fn: () => Promise<T>): Promise<T> {
  return store.run(domain, fn);
}

export function creativeDomain(): CreativeDomain | undefined {
  return store.getStore();
}

export function isBusinessDomain(): boolean {
  return store.getStore()?.kind === "business";
}

/**
 * Thinking effort for model calls made while writing a BUSINESS episode.
 *
 * The business research and dossier calls already pass an explicit effort,
 * because at the API default ("high") thinking filled the output cap. The
 * writing pipeline passes none, and the third Milestone 2 live run died the
 * same way: the debate architect's turn plan spent 20,392 output tokens and
 * 3.6 minutes thinking and returned no text (stop_reason max_tokens). Applied
 * like a per-call effort (it outranks LLM_EFFORT, as the research calls do);
 * an explicit per-call effort still wins. Sports calls run with no domain set
 * and get undefined — their behaviour is unchanged.
 */
export const BUSINESS_WRITING_EFFORT = "medium";
export function creativeDomainEffort(): string | undefined {
  return isBusinessDomain() ? BUSINESS_WRITING_EFFORT : undefined;
}
