// EVENT-LEVEL STORY CLUSTERING — "are these two topics the same story?"
//
// WHY THIS EXISTS
// ---------------
// Production episode e7867729 shipped a rundown of three "different" topics
// that were all the SAME event (the 2026 MLB All-Star Game, AL 4-0 NL, in
// Philadelphia):
//
//   1. "Was Mike Trout the Real Story of a Drama-Free All-Star Game?"
//   2. "Did the MLB All-Star Game Just Become a Snoozefest?"
//   3. "Is an 11-Pitcher All-Star Shutout Great Baseball or Spreadsheet Baseball?"
//
// The result restated one argument for 8.5 minutes. The cause was structural,
// not a bad model day: `selectAutoTopics` was a PURE TOP-N over a single
// scalar (`talkability * 0.6 + debateScore * 0.4`). Nothing in the ranking ever
// compared candidate i against the candidates ALREADY CHOSEN, so three angles
// on one event — each individually talkable — swept the board. The only dedupe
// in the system lived at GENERATION time (worker.ts) and required either an
// exact normalized-title match or an IDENTICAL evidence-id set; three
// overlapping-but-not-identical evidence sets sailed through it.
//
// (Note for future readers: the many `*diversity*` modules elsewhere in this
// repo are SOUND-CUE diversity. They have nothing to do with this file.)
//
// DESIGN CONSTRAINTS
//  - Fully offline and deterministic: no network, no API keys, no model calls,
//    no clock. Everything here is classical lexical semantics (stopword
//    stripping, light stemming, cosine over token vectors, Jaccard over
//    entity/evidence sets) plus the durable event-identity primitives in
//    `eventIdentity.ts` (alias resolution, claim fingerprints, concept
//    expansion) plus the hard identifiers the schema actually carries.
//  - Only REAL schema fields are read: TopicCandidate.{title, summary, sport,
//    leagueId, evidenceIds, createdAt}, ResearchBrief.{facts, sourceIds,
//    mainAngle, contrarianAngle, argumentForHostA/B}, TopicSource.{canonicalUrl,
//    originalUrl, publishedAt, title}, and — when a caller enriches — Game.{id,
//    homeTeamId, awayTeamId, scheduledAt, leagueId} and NewsItem.{id, url,
//    publishedAt, entities, title}.
//  - Every merge must be EXPLAINABLE. See THE NAMEABLE-SIGNAL RULE below.
//
// THE NAMEABLE-SIGNAL RULE (replaces the old, rejected "anchor rule")
// -------------------------------------------------------------------
// The first version of this module would only merge when it could name a HARD
// identifier: the same Game id, the same evidence row, the same article URL, or
// a heavy overlap of literal proper nouns. It shipped with the caveat that
// three paraphrases of one event with every identifier stripped would NOT be
// merged. That caveat was rejected, and rightly: a duplicate that changes its
// vocabulary is still a duplicate, and "we could not name a shared row" is not
// a reason to put the same story on the show three times.
//
// The rule now is that a merge must name a concrete shared SIGNAL — but a
// signal no longer has to be a database identifier. These all count, and each
// one prints as a sentence an operator can read:
//
//   1. shared_game            — the same Game row.
//   2. shared_teams_and_date  — the same fixture, from enriched Game rows.
//   3. shared_source_url      — the same article behind both topics.
//   4. shared_evidence(_row)  — the same evidence rows, with lexical support.
//   5. semantic_overlap       — heavy wording AND named-entity overlap.
//   6. canonical_entity_date  — the same two CANONICAL franchises (aliases
//                               resolved: "the Halos" == "LAA" == "Angels")
//                               within a day of each other, with concept
//                               support.
//   7. same_claim             — THE NEW ONE. Both topics assert the same
//                               normalized CLAIM: same final score, same event
//                               type, same action, same magnitudes, on the same
//                               day, in the same league, with corroborating
//                               concept-space similarity. This is what catches
//                               "the AL blanked the NL four to nothing" against
//                               "American League shuts out National League 4-0"
//                               when neither carries a game id, an evidence row,
//                               a URL, or a shared proper noun.
//
// PRECISION IS HELD BY VETOES, NOT BY REFUSING TO LOOK
// ----------------------------------------------------
// Widening recall on paraphrases without inviting false merges is done with
// explicit DISCRIMINATORS rather than a higher similarity bar. Signals 5-7 (the
// soft paths — the ones with no shared database row) are cancelled outright
// when any of these is true:
//
//   - date_conflict     : both sides carry dates and the closest pair is more
//                         than SAME_EVENT_MAX_DAY_GAP days apart. Two meetings
//                         of the same two teams in different weeks are two
//                         events, however identically they are written.
//   - disjoint_people   : both sides name at least one canonical PERSON and
//                         they share none. Two players on one team are two
//                         stories.
//   - disjoint_teams    : both sides name canonical franchises and share none.
//                         Two different 4-0 games on one night are two events.
//   - league_conflict   : the leagues disagree.
//   - claim_conflict    : both sides state a final score / batting line and the
//                         values differ.
//
// A veto never touches signals 1-4: if two topics literally cite the same Game
// row, no amount of prose disagreement makes them different events.
//
// The residual honest limitation: two topics with NO dates, NO canonical
// entities, NO claim atoms and NO shared rows — i.e. no propositional content
// at all — still cannot be merged, because there would be nothing to name.
// That is a statement about empty inputs, not about paraphrases.

import crypto from "crypto";
import {
  OPEN_QUESTION_MARKERS,
  RESOLUTION_ACTIONS,
  RESOLUTION_MARKERS,
  compareClaims,
  conceptsOf,
  configureEmbeddingHook,
  containsAnyPhrase,
  contentTokens,
  describeCanonicalEntity,
  expandConcepts,
  extractCanonicalEntities,
  extractClaimAtoms,
  forwardDayGap,
  isEmbeddingHookEnabled,
  minDayGap,
  normalizeNumbers,
  normalizeText,
  stemWord,
  toDayString,
  vectorCosine,
  type ClaimAtom,
  type ClaimComparison,
  type EmbeddingHook,
} from "./eventIdentity";

// The text primitives moved to `eventIdentity.ts` so the identity layer has no
// import cycle; they stay part of THIS module's public API unchanged.
export { contentTokens, normalizeText, stemWord, normalizeNumbers, extractClaimAtoms, compareClaims, configureEmbeddingHook, isEmbeddingHookEnabled, describeCanonicalEntity };
export type { ClaimAtom, ClaimComparison, EmbeddingHook };

// ---------------------------------------------------------------------------
// Thresholds (exported so a test can read them instead of hardcoding numbers)
// ---------------------------------------------------------------------------

/** Cosine over title+summary tokens above which two topics read as one story. */
export const SEMANTIC_SAME_EVENT_COSINE = 0.55;
/** Named-entity Jaccard required alongside the cosine on the semantic path. */
export const SEMANTIC_SAME_EVENT_ENTITY_JACCARD = 0.5;
/** Evidence-set Jaccard that, with a shared entity, means one event. */
export const EVIDENCE_SAME_EVENT_JACCARD = 0.5;
/** Lexical support required on the evidence path (keeps a shared roundup
 *  article from merging two genuinely different stories). */
export const EVIDENCE_PATH_MIN_COSINE = 0.25;
/** Overlap that is NOT a merge but IS enough to push a topic down the running
 *  order, so two adjacent segments never sound like a rerun of each other. */
export const SOFT_OVERLAP_COSINE = 0.45;
/** Minimum `scoreRundownDiversity` score for `passed`. */
export const RUNDOWN_DIVERSITY_THRESHOLD = 55;

// --- Durable-identity thresholds (the paraphrase-proof paths) --------------

/** The most identifying shared claim atom must be at least this strong. 0.5 is
 *  the weight of a specific ACTION (`act:shutout`); a bare `act:win` (0.15) can
 *  never carry a merge on its own. */
export const CLAIM_ANCHOR_MIN_PEAK = 0.5;
/** Total weight of shared claim atoms required. One score (0.95) is not enough
 *  on its own — it must be corroborated by an event type, action or magnitude. */
export const CLAIM_ANCHOR_MIN_WEIGHT = 1.2;
/** Shared claim atoms required, so a single coincidence never merges. */
export const CLAIM_ANCHOR_MIN_ATOMS = 2;
/** Concept-expanded cosine required alongside the claim match. */
export const CLAIM_ANCHOR_MIN_CONCEPT_COSINE = 0.32;
/** Canonical-franchise path: shared resolved franchises required. */
export const CANONICAL_ENTITY_MIN_TEAMS = 2;
/** Concept cosine required on the canonical-franchise path. */
export const CANONICAL_ENTITY_MIN_CONCEPT_COSINE = 0.3;
/** Days apart beyond which two stories cannot be the same event. */
export const SAME_EVENT_MAX_DAY_GAP = 1;
/** A later story must be at least this many days newer for the DATE alone to
 *  count as a meaningful new development. Under this, "newer" is just a
 *  follow-up article about the same facts. */
export const UPDATE_MIN_EVENT_DAY_GAP = 2;
/** A duplicate whose event is this many days behind the freshest event in the
 *  pool is STALE and is hard-blocked regardless of the per-event allowance. */
export const STALE_EVENT_DAYS = 3;
/** If an optional embedding hook is installed, this cosine corroborates the
 *  claim path. Never sufficient alone. Unused while no hook is installed. */
export const EMBEDDING_CORROBORATION_COSINE = 0.82;

// ---------------------------------------------------------------------------
// Input shapes — structural, so a Prisma row, a snapshot, or a fixture all fit
// ---------------------------------------------------------------------------

/** Optional enrichment: rows a caller resolved from evidence references. */
export interface TopicEventContext {
  games?: Array<{
    id: string;
    leagueId?: string | null;
    homeTeamId?: string | null;
    awayTeamId?: string | null;
    scheduledAt?: Date | string | null;
  }>;
  newsItems?: Array<{
    id: string;
    title?: string | null;
    url?: string | null;
    publishedAt?: Date | string | null;
    entities?: unknown;
  }>;
}

/** The minimum a topic must carry to be clustered. Mirrors TopicCandidate. */
export interface ClusterableTopic {
  id: string;
  title: string;
  summary?: string | null;
  sport?: string | null;
  leagueId?: string | null;
  createdAt?: Date | string | null;
  /** TopicCandidate.evidenceIds — a JSON array of { type, id } refs. */
  evidenceIds?: unknown;
  researchBrief?: {
    facts?: unknown;
    sourceIds?: unknown;
    mainAngle?: string | null;
    contrarianAngle?: string | null;
    argumentForHostA?: string | null;
    argumentForHostB?: string | null;
  } | null;
  /** TopicSource rows, when the caller included them. */
  sources?: Array<{
    canonicalUrl?: string | null;
    originalUrl?: string | null;
    title?: string | null;
    publishedAt?: Date | string | null;
  }> | null;
  /** Resolved Game/NewsItem rows, when the caller enriched them. */
  eventContext?: TopicEventContext | null;
  /** OPTIONAL sentence embedding, if a caller installed an encoder. Nothing in
   *  this repo supplies one; the offline path stands alone without it. */
  embedding?: number[] | null;
}

// ---------------------------------------------------------------------------
// Text normalization (primitives live in eventIdentity.ts, re-exported above)
// ---------------------------------------------------------------------------

/** Words that are capitalized in headline case but are not entity names. */
const NON_ENTITY_CAPITALS = new Set<string>([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "did", "do", "does", "for", "from",
  "game", "games", "great", "how", "in", "is", "it", "just", "night", "no", "not", "of", "off",
  "on", "or", "out", "over", "real", "season", "story", "the", "to", "up", "was", "were", "what",
  "when", "which", "who", "why", "will", "with", "year", "years", "yes", "topic", "day", "days",
  "team", "teams", "player", "players", "win", "wins", "loss", "losses", "big", "new", "next",
  "last", "first", "best", "worst", "good", "bad", "more", "most", "less", "least", "than", "that",
  "this", "these", "those", "here", "there", "now", "then", "still", "even", "become", "became",
]);

/** Named entities: capitalized words and capitalized runs, minus headline
 *  furniture. Returns lowercase forms; runs are kept as one entity
 *  ("mike trout") AND as their parts, so partial mentions still overlap. */
export function extractEntities(text: string | null | undefined): { entities: string[]; people: string[] } {
  if (!text) return { entities: [], people: [] };
  const entities = new Set<string>();
  const people = new Set<string>();
  // Sentence-initial capitals are ambiguous; the guard is NON_ENTITY_CAPITALS.
  const words = text.split(/[^A-Za-z0-9'\-]+/).filter(Boolean);
  let run: string[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const lower = run.map((w) => w.toLowerCase().replace(/'/g, ""));
    const phrase = lower.join(" ");
    if (run.length >= 2) {
      entities.add(phrase);
      // Two capitalized words, neither of them headline furniture and neither
      // an all-caps league code, read as a person's name.
      const looksLikePerson =
        run.length === 2 &&
        run.every((w) => /^[A-Z][a-z'’-]+$/.test(w)) &&
        lower.every((w) => !NON_ENTITY_CAPITALS.has(w));
      if (looksLikePerson) people.add(phrase);
    }
    for (const w of lower) {
      if (w.length < 3) continue;
      if (NON_ENTITY_CAPITALS.has(w)) continue;
      entities.add(w);
    }
    run = [];
  };
  for (const w of words) {
    const isCapital = /^[A-Z]/.test(w) || /^[A-Z0-9]{2,}$/.test(w);
    const bare = w.toLowerCase().replace(/'/g, "");
    if (isCapital && !NON_ENTITY_CAPITALS.has(bare)) {
      run.push(w);
    } else {
      flush();
    }
  }
  flush();
  return { entities: [...entities].sort(), people: [...people].sort() };
}

/** Host + path, lowercased, no scheme/query/fragment/trailing slash — the same
 *  article behind two different tracking URLs must compare equal. */
export function normalizeUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "").toLowerCase();
    return `${host}${path}`;
  } catch {
    return trimmed.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[?#]/)[0].replace(/\/+$/, "") || null;
  }
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>)\]]+/gi;

function collectUrlsFromJson(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > 4 || value == null) return;
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value.trim())) {
      const n = normalizeUrl(value);
      if (n) into.add(n);
      return;
    }
    const found = value.match(URL_IN_TEXT);
    if (found) for (const f of found) { const n = normalizeUrl(f); if (n) into.add(n); }
    return;
  }
  if (Array.isArray(value)) { for (const v of value) collectUrlsFromJson(v, into, depth + 1); return; }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectUrlsFromJson(v, into, depth + 1);
  }
}

/** `{ type, id }` refs out of an evidenceIds / sourceIds JSON column. Kept
 *  local (rather than importing the resolver) because clustering must work on
 *  fixtures and snapshots that were never resolved against the database. */
function evidenceKeysOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.type !== "string" || typeof r.id !== "string") continue;
    const type = r.type.trim();
    const id = r.id.trim();
    if (!type || !id) continue;
    keys.add(`${type}:${id}`);
  }
  return [...keys].sort();
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/** A durable, comparable identity for the EVENT a topic is about. */
export interface EventFingerprint {
  topicId: string;
  title: string;
  /** Uppercased leagueId, falling back to sport. */
  league: string | null;
  /** Game ids cited as evidence (plus any enriched Game rows). */
  gameIds: string[];
  /** Team ids from enriched Game rows. */
  teamIds: string[];
  /** YYYY-MM-DD days the underlying event/reporting sits on. */
  eventDates: string[];
  /** YYYY-MM-DD days the topic itself was written/published on. Weaker than
   *  `eventDates` but present even when a topic carries no resolved rows. */
  publicationDates: string[];
  /** eventDates ∪ publicationDates — what temporal proximity is judged on. */
  allDates: string[];
  /** Capitalized-run entities from the title/summary/news entities. */
  entities: string[];
  /** The subset of `entities` that read as a person's name. */
  people: string[];
  /** Alias-resolved franchise/conference ids ("MLB:LAA"), so "the Halos",
   *  "Angels", "LAA" and "Los Angeles Angels" are ONE entity. */
  canonicalTeams: string[];
  /** Full person names that survived the possessive/common-word filters. */
  canonicalPeople: string[];
  /** Surnames for those people, so "Trout" matches "Mike Trout". */
  personKeys: string[];
  /** Normalized propositional atoms — the claim fingerprint. */
  claimAtoms: ClaimAtom[];
  /** Concept ids the prose triggers (SHUTOUT, EXHIBITION, ...). */
  concepts: string[];
  /** `textTokens` expanded with curated concept markers. */
  conceptTokens: string[];
  /** Optional caller-supplied sentence embedding. Absent by default. */
  embedding: number[] | null;
  /** "type:id" evidence + brief-source refs. */
  evidenceKeys: string[];
  /** Normalized article URLs from TopicSource / NewsItem / brief JSON. */
  sourceUrls: string[];
  /** Stopword-stripped stemmed title tokens. */
  titleTokens: string[];
  /** Title (double weighted) + summary + brief angles tokens. */
  textTokens: string[];
  /** The topic's prose, joined and normalized but NOT tokenized — phrase-level
   *  markers ("awaiting a ruling", "was suspended") only exist in running text. */
  prose: string;
  /** sha1 over the sorted unique title tokens — stable across rewordings that
   *  only reorder or repunctuate. */
  titleFingerprint: string;
  /** sha1 over the sorted claim atoms — stable across a full paraphrase,
   *  because it is built from propositions, not from words. */
  claimFingerprint: string;
  /** Composite identifier: the strongest durable anchor available. */
  key: string;
}

/**
 * Build a durable event identity from what a topic row actually carries.
 * Everything is optional except id + title; absent fields simply contribute
 * nothing rather than being invented.
 */
export function deriveEventFingerprint(topic: ClusterableTopic): EventFingerprint {
  const brief = topic.researchBrief ?? null;

  const evidenceKeys = new Set<string>([
    ...evidenceKeysOf(topic.evidenceIds),
    ...evidenceKeysOf(brief?.sourceIds),
  ]);

  const gameIds = new Set<string>();
  for (const key of evidenceKeys) {
    if (key.startsWith("game:")) gameIds.add(key.slice("game:".length));
  }

  const teamIds = new Set<string>();
  const eventDates = new Set<string>();
  const publicationDates = new Set<string>();
  const sourceUrls = new Set<string>();

  for (const g of topic.eventContext?.games ?? []) {
    if (g.id) gameIds.add(g.id);
    if (g.homeTeamId) teamIds.add(g.homeTeamId);
    if (g.awayTeamId) teamIds.add(g.awayTeamId);
    const day = toDayString(g.scheduledAt);
    if (day) eventDates.add(day);
  }

  const league = (topic.leagueId || topic.sport || "").trim().toUpperCase() || null;

  const entityBag = new Set<string>();
  const peopleBag = new Set<string>();
  const canonicalTeams = new Set<string>();
  const canonicalPeople = new Set<string>();
  const personKeys = new Set<string>();

  const absorbText = (text: string | null | undefined) => {
    const { entities, people } = extractEntities(text);
    for (const e of entities) entityBag.add(e);
    for (const p of people) peopleBag.add(p);
    // Alias resolution runs on the RAW text so capitalisation is still intact.
    const canon = extractCanonicalEntities(text, league);
    for (const t of canon.teams) canonicalTeams.add(t);
    for (const p of canon.people) canonicalPeople.add(p);
    for (const k of canon.personKeys) personKeys.add(k);
  };

  absorbText(topic.title);
  absorbText(topic.summary);
  absorbText(brief?.mainAngle);
  absorbText(brief?.contrarianAngle);

  for (const n of topic.eventContext?.newsItems ?? []) {
    const day = toDayString(n.publishedAt);
    if (day) eventDates.add(day);
    const u = normalizeUrl(n.url);
    if (u) sourceUrls.add(u);
    absorbText(n.title);
    // NewsItem.entities is a JSON array of extracted entity strings.
    if (Array.isArray(n.entities)) {
      for (const e of n.entities) {
        if (typeof e === "string" && e.trim().length >= 3) {
          entityBag.add(e.trim().toLowerCase());
          const canon = extractCanonicalEntities(e.trim(), league);
          for (const t of canon.teams) canonicalTeams.add(t);
          for (const p of canon.people) canonicalPeople.add(p);
          for (const k of canon.personKeys) personKeys.add(k);
        }
      }
    }
  }

  for (const s of topic.sources ?? []) {
    const u = normalizeUrl(s.canonicalUrl) ?? normalizeUrl(s.originalUrl);
    if (u) sourceUrls.add(u);
    const day = toDayString(s.publishedAt);
    if (day) eventDates.add(day);
    absorbText(s.title);
  }

  const createdDay = toDayString(topic.createdAt);
  if (createdDay) publicationDates.add(createdDay);

  collectUrlsFromJson(brief?.sourceIds, sourceUrls);
  collectUrlsFromJson(brief?.facts, sourceUrls);

  if (league) {
    // A league code is an entity in name only — every topic in a single-league
    // show shares it, so it must never be what holds a cluster together.
    entityBag.delete(league.toLowerCase());
  }

  const titleTokens = contentTokens(topic.title);
  const textTokens = [
    ...titleTokens,
    ...titleTokens, // title carries the thesis; weight it twice
    ...contentTokens(topic.summary),
    ...contentTokens(brief?.mainAngle),
    ...contentTokens(brief?.contrarianAngle),
  ];

  // The CLAIM FINGERPRINT is built from every piece of prose the topic carries,
  // because the propositional content ("4-0 shutout at the all-star exhibition")
  // is scattered across the title, the summary and both angles.
  const claimSource = [
    topic.title,
    topic.summary ?? "",
    brief?.mainAngle ?? "",
    brief?.contrarianAngle ?? "",
    ...(topic.eventContext?.newsItems ?? []).map((n) => n.title ?? ""),
    ...(topic.sources ?? []).map((s) => s.title ?? ""),
  ].join(" . ");
  const claimAtoms = extractClaimAtoms(claimSource);
  const prose = normalizeText(claimSource);

  const concepts = conceptsOf(textTokens);
  const conceptTokens = expandConcepts(textTokens);

  const titleFingerprint = crypto
    .createHash("sha1")
    .update([...new Set(titleTokens)].sort().join("|"))
    .digest("hex")
    .slice(0, 16);

  const claimFingerprint = crypto
    .createHash("sha1")
    .update(claimAtoms.map((a) => a.atom).join("|"))
    .digest("hex")
    .slice(0, 16);

  const sortedGames = [...gameIds].sort();
  const sortedTeams = [...teamIds].sort();
  const sortedDates = [...eventDates].sort();
  const sortedPubDates = [...publicationDates].sort();
  const allDates = [...new Set([...sortedDates, ...sortedPubDates])].sort();

  const sortedCanonTeams = [...canonicalTeams].sort();

  // The composite key prefers the strongest durable anchor present. The claim
  // fingerprint sits above the title digest because it survives a paraphrase.
  const key = sortedGames.length > 0
    ? `game:${sortedGames.join("+")}`
    : sortedTeams.length > 0 && sortedDates.length > 0
      ? `teams:${sortedTeams.join("+")}@${sortedDates[0]}`
      : sortedCanonTeams.length > 0 && allDates.length > 0
        ? `canon:${sortedCanonTeams.join("+")}@${allDates[0]}`
        : claimAtoms.length > 0
          ? `${league ?? "-"}:claim:${claimFingerprint}`
          : `${league ?? "-"}:title:${titleFingerprint}`;

  return {
    topicId: topic.id,
    title: topic.title,
    league,
    gameIds: sortedGames,
    teamIds: sortedTeams,
    eventDates: sortedDates,
    publicationDates: sortedPubDates,
    allDates,
    entities: [...entityBag].sort(),
    people: [...peopleBag].sort(),
    canonicalTeams: sortedCanonTeams,
    canonicalPeople: [...canonicalPeople].sort(),
    personKeys: [...personKeys].sort(),
    claimAtoms,
    concepts,
    conceptTokens,
    embedding: Array.isArray(topic.embedding) ? topic.embedding : null,
    evidenceKeys: [...evidenceKeys].sort(),
    sourceUrls: [...sourceUrls].sort(),
    titleTokens,
    textTokens,
    prose,
    titleFingerprint,
    claimFingerprint,
    key,
  };
}

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

function termVector(tokens: string[]): Map<string, number> {
  const v = new Map<string, number>();
  for (const t of tokens) v.set(t, (v.get(t) ?? 0) + 1);
  return v;
}

/** Cosine over raw term-frequency vectors. 0 when either side is empty. */
export function cosineSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const va = termVector(a);
  const vb = termVector(b);
  let dot = 0;
  for (const [t, n] of va) dot += n * (vb.get(t) ?? 0);
  if (dot === 0) return 0;
  let na = 0;
  for (const n of va.values()) na += n * n;
  let nb = 0;
  for (const n of vb.values()) nb += n * n;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** |A ∩ B| / |A ∪ B|. 0 when both sides are empty (no evidence of sameness). */
export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

const intersect = (a: string[], b: string[]): string[] => {
  const sb = new Set(b);
  return a.filter((x) => sb.has(x));
};

/** Which concrete signal made two topics the same event. */
export type DuplicateSignalCode =
  | "shared_game"
  | "shared_teams_and_date"
  | "shared_source_url"
  | "shared_evidence"
  | "shared_evidence_row"
  | "semantic_overlap"
  | "canonical_entity_date"
  | "same_claim";

/** Signals backed by a literal shared database row or URL. Vetoes never apply
 *  to these — two topics citing one Game row ARE one event. */
const HARD_SIGNAL_CODES = new Set<DuplicateSignalCode>([
  "shared_game",
  "shared_teams_and_date",
  "shared_source_url",
  "shared_evidence",
  "shared_evidence_row",
]);

export interface DuplicateSignal {
  code: DuplicateSignalCode;
  /** Operator-readable, names the shared thing. */
  detail: string;
  /** 0..1 — how conclusive this signal is on its own. */
  weight: number;
}

/** Why an otherwise-plausible soft merge was refused. */
export type DiscriminatorCode =
  | "date_conflict"
  | "disjoint_people"
  | "disjoint_teams"
  | "league_conflict"
  | "claim_conflict";

export interface Discriminator {
  code: DiscriminatorCode;
  /** Operator-readable, names the thing that differs. */
  detail: string;
}

export interface TopicSimilarity {
  topicIdA: string;
  topicIdB: string;
  /** Cosine over title(x2)+summary+angle tokens. */
  lexicalCosine: number;
  /** Cosine over title tokens only. */
  titleCosine: number;
  /** Jaccard over named entities. */
  entityJaccard: number;
  /** Jaccard over evidence refs + article URLs. */
  evidenceJaccard: number;
  /** Jaccard over person-shaped entities. */
  peopleJaccard: number;
  /** Cosine over concept-EXPANDED tokens — the offline semantic signal. */
  conceptCosine: number;
  /** Cosine over caller-supplied embeddings; 0 when none were supplied. */
  embeddingCosine: number;
  /** Claim-fingerprint comparison (the paraphrase-proof signal). */
  claim: ClaimComparison;
  sharedGameIds: string[];
  sharedEntities: string[];
  sharedEvidenceKeys: string[];
  sharedSourceUrls: string[];
  sharedTeamIds: string[];
  sharedDates: string[];
  /** Alias-resolved franchises present on both sides. */
  sharedCanonicalTeams: string[];
  /** People present on both sides (by surname key). */
  sharedPersonKeys: string[];
  /** Closest gap in days between the two topics' dates; null when unknown. */
  dayGap: number | null;
  /** Reasons a soft merge was refused. Empty when nothing discriminates. */
  discriminators: Discriminator[];
  /** True only when a NAMED signal supports the merge and nothing vetoes it. */
  sameEvent: boolean;
  /** 0..1 confidence in `sameEvent`. */
  confidence: number;
  signals: DuplicateSignal[];
  /** Blended 0..1 "how much do these two overlap" used for soft ordering. */
  overlap: number;
}

/** Compare two already-derived fingerprints. */
export function compareFingerprints(a: EventFingerprint, b: EventFingerprint): TopicSimilarity {
  const sharedGameIds = intersect(a.gameIds, b.gameIds);
  const sharedEntities = intersect(a.entities, b.entities);
  const sharedEvidenceKeys = intersect(a.evidenceKeys, b.evidenceKeys);
  const sharedSourceUrls = intersect(a.sourceUrls, b.sourceUrls);
  const sharedTeamIds = intersect(a.teamIds, b.teamIds);
  const sharedDates = intersect(a.eventDates, b.eventDates);
  const sharedCanonicalTeams = intersect(a.canonicalTeams, b.canonicalTeams);
  const sharedPersonKeys = intersect(a.personKeys, b.personKeys);

  const lexicalCosine = cosineSimilarity(a.textTokens, b.textTokens);
  const titleCosine = cosineSimilarity(a.titleTokens, b.titleTokens);
  const conceptCosine = cosineSimilarity(a.conceptTokens, b.conceptTokens);
  const embeddingCosine = vectorCosine(a.embedding, b.embedding);
  const entityJaccard = jaccard(a.entities, b.entities);
  const peopleJaccard = jaccard(a.people, b.people);
  const evidenceJaccard = jaccard(
    [...a.evidenceKeys, ...a.sourceUrls],
    [...b.evidenceKeys, ...b.sourceUrls]
  );
  const claim = compareClaims(a.claimAtoms, b.claimAtoms);
  const dayGap = minDayGap(a.allDates, b.allDates);

  // --- DISCRIMINATORS -------------------------------------------------------
  // Computed BEFORE any soft signal so the vetoes are visible in the report
  // even when nothing would have merged anyway.
  const discriminators: Discriminator[] = [];
  if (dayGap !== null && dayGap > SAME_EVENT_MAX_DAY_GAP) {
    discriminators.push({
      code: "date_conflict",
      detail: `${Math.round(dayGap)} days apart (${a.allDates.join("/")} vs ${b.allDates.join("/")}) — beyond the ${SAME_EVENT_MAX_DAY_GAP}-day window for one event`,
    });
  }
  if (a.personKeys.length > 0 && b.personKeys.length > 0 && sharedPersonKeys.length === 0) {
    discriminators.push({
      code: "disjoint_people",
      detail: `different principals: ${a.canonicalPeople.join(", ") || a.personKeys.join(", ")} vs ${b.canonicalPeople.join(", ") || b.personKeys.join(", ")}`,
    });
  }
  if (a.canonicalTeams.length > 0 && b.canonicalTeams.length > 0 && sharedCanonicalTeams.length === 0) {
    discriminators.push({
      code: "disjoint_teams",
      detail: `no franchise in common: ${a.canonicalTeams.map(describeCanonicalEntity).join(", ")} vs ${b.canonicalTeams.map(describeCanonicalEntity).join(", ")}`,
    });
  }
  if (a.league && b.league && a.league !== b.league) {
    discriminators.push({ code: "league_conflict", detail: `different leagues (${a.league} vs ${b.league})` });
  }
  if (claim.conflicts.length > 0) {
    discriminators.push({
      code: "claim_conflict",
      detail: `incompatible figures — ${claim.conflicts.join("; ")}`,
    });
  }
  const softMergeVetoed = discriminators.length > 0;
  const temporallyProximate = dayGap === null || dayGap <= SAME_EVENT_MAX_DAY_GAP;
  const leagueCompatible = a.league == null || b.league == null || a.league === b.league;

  const signals: DuplicateSignal[] = [];

  // (1) Same Game row — the strongest identifier the schema has.
  if (sharedGameIds.length > 0) {
    signals.push({
      code: "shared_game",
      detail: `both cite the same game (gameId ${sharedGameIds.join(", ")})`,
      weight: 1,
    });
  }

  // (2) Same teams on the same day — one fixture, however it is worded.
  if (sharedTeamIds.length >= 2 && sharedDates.length > 0) {
    signals.push({
      code: "shared_teams_and_date",
      detail: `same teams (${sharedTeamIds.join(", ")}) on the same date (${sharedDates.join(", ")})`,
      weight: 0.95,
    });
  }

  // (3) Same article, with at least some agreement about what it is about.
  if (sharedSourceUrls.length > 0 && (entityJaccard >= 0.34 || lexicalCosine >= 0.3)) {
    signals.push({
      code: "shared_source_url",
      detail: `both are sourced from ${sharedSourceUrls.slice(0, 2).join(", ")}`,
      weight: 0.85,
    });
  }

  // (4) Dominantly overlapping evidence AND a shared name AND lexical support.
  const evidenceUnionSize = new Set([
    ...a.evidenceKeys, ...a.sourceUrls, ...b.evidenceKeys, ...b.sourceUrls,
  ]).size;
  const sharedEvidenceCount = sharedEvidenceKeys.length + sharedSourceUrls.length;
  if (
    sharedEvidenceCount > 0 &&
    evidenceJaccard >= EVIDENCE_SAME_EVENT_JACCARD &&
    sharedEntities.length >= 1 &&
    lexicalCosine >= EVIDENCE_PATH_MIN_COSINE
  ) {
    signals.push({
      code: "shared_evidence",
      detail: `share ${sharedEvidenceCount} of ${evidenceUnionSize} evidence sources (${sharedEvidenceKeys.concat(sharedSourceUrls).slice(0, 3).join(", ")})`,
      weight: 0.9,
    });
  }

  // (4b) The SAME source row, plus agreement about who the story is about.
  //      Rule (4) asks for the evidence sets to overlap DOMINANTLY, which two
  //      well-researched angles on one event often fail: each cites the shared
  //      recap plus two of its own specialist pieces, so the Jaccard lands near
  //      0.15 while the topics remain the same story. Citing one identical
  //      article row is itself a nameable anchor; the two-entity and lexical
  //      requirements are what stop a big weekly roundup from merging every
  //      topic that happened to cite it.
  const sharedRowKeys = sharedEvidenceKeys.filter((k) => !k.startsWith("topicSource:"));
  if (
    sharedRowKeys.length > 0 &&
    sharedEntities.length >= 2 &&
    lexicalCosine >= EVIDENCE_PATH_MIN_COSINE
  ) {
    signals.push({
      code: "shared_evidence_row",
      detail: `both cite ${sharedRowKeys.slice(0, 2).join(", ")} and agree on ${sharedEntities.length} named entities (${sharedEntities.slice(0, 3).join(", ")})`,
      weight: 0.85,
    });
  }

  // (5) No shared row, but the same story told twice: heavy wording overlap
  //     PLUS a heavily overlapping cast of named entities. The entity
  //     requirement is THE ANCHOR RULE — wording alone never merges.
  if (
    !softMergeVetoed &&
    lexicalCosine >= SEMANTIC_SAME_EVENT_COSINE &&
    entityJaccard >= SEMANTIC_SAME_EVENT_ENTITY_JACCARD &&
    sharedEntities.length >= 2 &&
    leagueCompatible
  ) {
    signals.push({
      code: "semantic_overlap",
      detail: `${Math.round(lexicalCosine * 100)}% wording overlap and ${Math.round(entityJaccard * 100)}% entity overlap (shared: ${sharedEntities.slice(0, 4).join(", ")})`,
      weight: 0.8,
    });
  }

  // (6) The same CANONICAL franchises within a day of each other. Alias
  //     resolution is what makes this work across "the Halos" / "LAA" /
  //     "Los Angeles Angels": the surface strings never match, the ids do.
  if (
    !softMergeVetoed &&
    sharedCanonicalTeams.length >= CANONICAL_ENTITY_MIN_TEAMS &&
    temporallyProximate &&
    leagueCompatible &&
    conceptCosine >= CANONICAL_ENTITY_MIN_CONCEPT_COSINE
  ) {
    signals.push({
      code: "canonical_entity_date",
      detail: `the same ${sharedCanonicalTeams.length} franchises (${sharedCanonicalTeams.map(describeCanonicalEntity).join(", ")}) ${dayGap === null ? "with no conflicting dates" : `within ${Math.round(dayGap)} day(s)`}, and ${Math.round(conceptCosine * 100)}% concept-space overlap`,
      weight: 0.78,
    });
  }

  // (7) THE SAME CLAIM. No shared row, no shared proper noun required: both
  //     topics assert the same normalized proposition — same final score, same
  //     event type, same action, same magnitudes — on the same day, in the same
  //     league, with concept-space agreement. This is the path that stops a
  //     paraphrase from evading duplicate protection, and it still NAMES what
  //     is shared, atom by atom.
  const embeddingCorroborates =
    a.embedding != null && b.embedding != null && embeddingCosine >= EMBEDDING_CORROBORATION_COSINE;
  if (
    !softMergeVetoed &&
    claim.peakWeight >= CLAIM_ANCHOR_MIN_PEAK &&
    claim.sharedWeight >= CLAIM_ANCHOR_MIN_WEIGHT &&
    claim.sharedAtoms.length >= CLAIM_ANCHOR_MIN_ATOMS &&
    (conceptCosine >= CLAIM_ANCHOR_MIN_CONCEPT_COSINE || embeddingCorroborates) &&
    temporallyProximate &&
    leagueCompatible
  ) {
    const named = claim.sharedAtoms.slice(0, 4).map((x) => x.label).join(", ");
    signals.push({
      code: "same_claim",
      detail:
        `both state the same claim — ${named} ` +
        `(atoms ${claim.sharedAtoms.slice(0, 4).map((x) => x.atom).join(", ")}; ` +
        `${Math.round(claim.jaccard * 100)}% claim overlap, ${Math.round(conceptCosine * 100)}% concept-space overlap` +
        `${dayGap === null ? "" : `, ${Math.round(dayGap)} day(s) apart`})`,
      weight: 0.82,
    });
  }

  const hardSignals = signals.filter((s) => HARD_SIGNAL_CODES.has(s.code));
  const confidence = signals.reduce((m, s) => Math.max(m, s.weight), 0);
  const overlap = Math.max(
    lexicalCosine,
    entityJaccard,
    evidenceJaccard,
    0.5 * (titleCosine + entityJaccard)
  );

  return {
    topicIdA: a.topicId,
    topicIdB: b.topicId,
    lexicalCosine,
    titleCosine,
    entityJaccard,
    evidenceJaccard,
    peopleJaccard,
    conceptCosine,
    embeddingCosine,
    claim,
    sharedGameIds,
    sharedEntities,
    sharedEvidenceKeys,
    sharedSourceUrls,
    sharedTeamIds,
    sharedDates,
    sharedCanonicalTeams,
    sharedPersonKeys,
    dayGap,
    // Only report the vetoes that actually mattered: when a hard shared row
    // carried the merge, a wording discrepancy is noise, not a discriminator.
    discriminators: hardSignals.length > 0 ? [] : discriminators,
    sameEvent: signals.length > 0,
    confidence,
    signals,
    overlap,
  };
}

/** Compare two topic rows. */
export function compareTopics(a: ClusterableTopic, b: ClusterableTopic): TopicSimilarity {
  return compareFingerprints(deriveEventFingerprint(a), deriveEventFingerprint(b));
}

/**
 * Human-readable reasons two topics are (or are not) the same story. Written
 * for an operator staring at a rundown, not for a log parser.
 */
export function explainDuplicate(a: ClusterableTopic, b: ClusterableTopic): string[] {
  return explainSimilarity(a.title, b.title, compareTopics(a, b));
}

/** The same explanation, from an already-computed comparison. */
export function explainSimilarity(titleA: string, titleB: string, sim: TopicSimilarity): string[] {
  if (sim.signals.length === 0) {
    const near: string[] = [];
    if (sim.lexicalCosine > 0) near.push(`${Math.round(sim.lexicalCosine * 100)}% wording overlap`);
    if (sim.conceptCosine > 0) near.push(`${Math.round(sim.conceptCosine * 100)}% concept-space overlap`);
    if (sim.entityJaccard > 0) near.push(`${Math.round(sim.entityJaccard * 100)}% entity overlap`);
    if (sim.claim.sharedAtoms.length > 0) {
      near.push(`${sim.claim.sharedAtoms.length} shared claim atom(s) (${sim.claim.sharedAtoms.slice(0, 3).map((x) => x.atom).join(", ")})`);
    }
    if (sim.sharedEvidenceKeys.length > 0) near.push(`${sim.sharedEvidenceKeys.length} shared evidence ref(s)`);
    const lines = [
      near.length > 0
        ? `Different events: ${near.join(", ")} — below the bar for a merge, and no shared game, article, claim, or entity pair to name.`
        : "Different events: nothing shared — no game, article, evidence, entity, claim, or wording overlap.",
    ];
    // When something DID look alike, say which discriminator settled it. An
    // operator reading "these two are 60% alike but not the same event" needs
    // the reason, not the number.
    for (const d of sim.discriminators) lines.push(`- discriminator (${d.code}): ${d.detail}`);
    return lines;
  }
  const head = `'${titleA}' and '${titleB}' look like the same event (${Math.round(sim.confidence * 100)}% confidence):`;
  return [head, ...sim.signals.map((s) => `- ${s.detail}`)];
}

// ---------------------------------------------------------------------------
// Update vs duplicate
// ---------------------------------------------------------------------------

/** What a same-event candidate is, relative to the topic already selected. */
export type EventRelation = "duplicate" | "update" | "distinct";

export interface RelationVerdict {
  relation: EventRelation;
  /** One operator-readable sentence. */
  reason: string;
  /** The specific new developments found, empty for a pure restatement. */
  developments: string[];
  /** True when the candidate's event is well behind the freshest in the pool. */
  stale: boolean;
  /** Days the candidate's event sits after the incumbent's (negative = older). */
  forwardGap: number | null;
}

const relationTextOf = (fp: EventFingerprint): string => fp.prose;

/**
 * Decide whether `candidate` is a genuine UPDATE to `incumbent` or just another
 * restatement of the same facts. Stated as a rule set, because "the model
 * thought so" is not something an operator can argue with:
 *
 *   R1 NEW ACTOR      — the candidate names a canonical PERSON the incumbent
 *                       never mentions. A new principal is new information.
 *   R2 NEW OUTCOME    — the candidate carries a RESOLUTION-class claim atom
 *                       (trade / signing / firing / discipline / injury /
 *                       retirement / clinch-or-elimination) that the incumbent
 *                       lacks. Something happened that had not happened before.
 *   R3 NEWER EVENT    — the candidate's event is at least
 *                       UPDATE_MIN_EVENT_DAY_GAP days after the incumbent's.
 *                       One day is a second write-up of the same night; two is
 *                       a new development.
 *   R4 RESOLVED       — the incumbent left an explicit open question ("awaiting
 *                       a ruling", "no timetable") and the candidate closes it
 *                       ("was suspended", "underwent surgery", "made official").
 *
 * Any rule firing, with the candidate not OLDER than the incumbent, makes this
 * an UPDATE. Nothing firing makes it a DUPLICATE, which is hard-blocked.
 */
export function classifyEventRelation(
  incumbent: EventFingerprint,
  candidate: EventFingerprint,
  opts: { referenceDate?: string | null; sameEvent?: boolean } = {}
): RelationVerdict {
  const sameEvent = opts.sameEvent ?? compareFingerprints(incumbent, candidate).sameEvent;
  const forwardGap = forwardDayGap(incumbent.allDates, candidate.allDates);

  // Staleness is measured against a REFERENCE day supplied by the caller (the
  // freshest event in the pool), never against a clock — CI must be reproducible.
  const candidateNewest = candidate.allDates.slice().sort().at(-1) ?? null;
  const stale =
    opts.referenceDate != null && candidateNewest != null
      ? (Date.parse(`${opts.referenceDate}T00:00:00Z`) - Date.parse(`${candidateNewest}T00:00:00Z`)) / 86_400_000 >
        STALE_EVENT_DAYS
      : false;

  if (!sameEvent) {
    return {
      relation: "distinct",
      reason: "Different events — no shared signal strong enough to merge them.",
      developments: [],
      stale,
      forwardGap,
    };
  }

  const developments: string[] = [];

  // R1 — a canonical person the incumbent never names.
  const newPeople = candidate.canonicalPeople.filter((p) => !incumbent.canonicalPeople.includes(p));
  const newKeys = candidate.personKeys.filter((k) => !incumbent.personKeys.includes(k));
  if (newPeople.length > 0 && newKeys.length > 0) {
    developments.push(`introduces a principal the earlier story never mentions (${newPeople.join(", ")})`);
  }

  // R2 — a resolution-class action the incumbent does not carry.
  const incumbentAtoms = new Set(incumbent.claimAtoms.map((x) => x.atom));
  const newResolutions = candidate.claimAtoms.filter(
    (x) => RESOLUTION_ACTIONS.has(x.atom) && !incumbentAtoms.has(x.atom)
  );
  if (newResolutions.length > 0) {
    developments.push(`reports a new outcome the earlier story does not have (${newResolutions.map((x) => x.label).join(", ")})`);
  }

  // R3 — a materially newer event date.
  if (forwardGap !== null && forwardGap >= UPDATE_MIN_EVENT_DAY_GAP) {
    developments.push(`is ${Math.round(forwardGap)} days newer than the story already selected`);
  }

  // R4 — an open question in the incumbent, closed by the candidate.
  const open = containsAnyPhrase(relationTextOf(incumbent), OPEN_QUESTION_MARKERS);
  const closed = containsAnyPhrase(relationTextOf(candidate), RESOLUTION_MARKERS);
  if (open && closed) {
    developments.push(`resolves the open question in the earlier story ('${open}' -> '${closed}')`);
  }

  const isOlder = forwardGap !== null && forwardGap < 0;
  if (developments.length > 0 && !isOlder) {
    return {
      relation: "update",
      reason: `Same event as the story already selected, but it ${developments.join("; and it ")}.`,
      developments,
      stale,
      forwardGap,
    };
  }

  return {
    relation: "duplicate",
    reason: isOlder
      ? `Same event as the story already selected, and ${Math.abs(Math.round(forwardGap!))} day(s) older — a restatement, not a development.`
      : "Same event as the story already selected, with no new development — it restates facts the rundown already carries.",
    developments: [],
    stale,
    forwardGap,
  };
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

export interface EventCluster {
  /** Deterministic id derived from the member fingerprints. */
  id: string;
  /** Member topic ids, in input order. */
  topicIds: string[];
  /** The first member in input order — the one selection keeps. */
  representativeTopicId: string;
  /** Short operator label for the event (shared entities / teams / date). */
  label: string;
  /** The concrete signals holding this cluster together. */
  anchors: string[];
}

export interface ClusteringResult {
  clusters: EventCluster[];
  /** topicId -> clusterId. */
  clusterIdByTopicId: Record<string, string>;
  /** Every pairwise comparison, for reporting. */
  pairs: TopicSimilarity[];
  /** Fingerprints, keyed by topic id (so callers don't recompute). */
  fingerprints: Record<string, EventFingerprint>;
}

/**
 * Group topics that describe the same underlying event.
 *
 * Union-find over pairwise `sameEvent`, so A~B and B~C put A, B and C in one
 * cluster even when A and C share nothing directly — which is exactly the
 * All-Star shape, where the "Trout" angle and the "spreadsheet baseball" angle
 * have little in common beyond both being that one game.
 */
export function clusterTopicsByEvent(topics: ClusterableTopic[]): ClusteringResult {
  const fingerprints = topics.map(deriveEventFingerprint);
  const parent = fingerprints.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) { const n = parent[i]; parent[i] = r; i = n; }
    return r;
  };
  const union = (i: number, j: number) => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[Math.max(ri, rj)] = Math.min(ri, rj);
  };

  const pairs: TopicSimilarity[] = [];
  for (let i = 0; i < fingerprints.length; i++) {
    for (let j = i + 1; j < fingerprints.length; j++) {
      const sim = compareFingerprints(fingerprints[i], fingerprints[j]);
      pairs.push(sim);
      if (sim.sameEvent) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < fingerprints.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }

  const simByPair = new Map<string, TopicSimilarity>();
  for (const p of pairs) simByPair.set(`${p.topicIdA}|${p.topicIdB}`, p);

  const clusters: EventCluster[] = [];
  const clusterIdByTopicId: Record<string, string> = {};
  const sortedRoots = [...groups.keys()].sort((x, y) => x - y);
  for (const root of sortedRoots) {
    const members = groups.get(root)!.sort((x, y) => x - y);
    const memberFps = members.map((i) => fingerprints[i]);
    const topicIds = memberFps.map((f) => f.topicId);

    const anchors: string[] = [];
    for (let x = 0; x < members.length; x++) {
      for (let y = x + 1; y < members.length; y++) {
        const sim = simByPair.get(`${memberFps[x].topicId}|${memberFps[y].topicId}`);
        if (!sim) continue;
        for (const s of sim.signals) {
          const line = `${memberFps[x].topicId} ~ ${memberFps[y].topicId}: ${s.detail}`;
          if (!anchors.includes(line)) anchors.push(line);
        }
      }
    }

    const sharedGames = memberFps.reduce<string[]>(
      (acc, f, idx) => (idx === 0 ? f.gameIds : intersect(acc, f.gameIds)), []);
    const sharedEnt = memberFps.reduce<string[]>(
      (acc, f, idx) => (idx === 0 ? f.entities : intersect(acc, f.entities)), []);
    const sharedCanon = memberFps.reduce<string[]>(
      (acc, f, idx) => (idx === 0 ? f.canonicalTeams : intersect(acc, f.canonicalTeams)), []);
    const sharedClaim = memberFps.reduce<string[]>(
      (acc, f, idx) => (idx === 0 ? f.claimAtoms.map((x) => x.atom) : intersect(acc, f.claimAtoms.map((x) => x.atom))), []);
    const label = sharedGames.length > 0
      ? `game ${sharedGames[0]}`
      : sharedCanon.length > 0
        ? sharedCanon.map(describeCanonicalEntity).slice(0, 3).join(" / ")
        : sharedEnt.length > 0
          ? sharedEnt.slice(0, 3).join(" / ")
          : sharedClaim.length > 0
            ? sharedClaim.slice(0, 3).join(" + ")
            : memberFps[0].title;

    const id = `evt-${crypto.createHash("sha1").update(topicIds.slice().sort().join("|")).digest("hex").slice(0, 12)}`;
    for (const t of topicIds) clusterIdByTopicId[t] = id;
    clusters.push({ id, topicIds, representativeTopicId: topicIds[0], label, anchors });
  }

  const fingerprintMap: Record<string, EventFingerprint> = {};
  for (const f of fingerprints) fingerprintMap[f.topicId] = f;

  return { clusters, clusterIdByTopicId, pairs, fingerprints: fingerprintMap };
}

// ---------------------------------------------------------------------------
// Enforcement (the part selection calls)
// ---------------------------------------------------------------------------

export interface DiversitySkip {
  topicId: string;
  title: string;
  clusterId: string;
  /** The topic already in the rundown that this one duplicates. */
  duplicateOfTopicId: string;
  duplicateOfTitle: string;
  confidence: number;
  /** Human-readable, straight from `explainDuplicate`. */
  reasons: string[];
  /** Duplicate vs update, from `classifyEventRelation`. */
  relation: EventRelation;
  /** True when the event is well behind the freshest in the pool. */
  stale: boolean;
}

export interface DiversityDeferral {
  topicId: string;
  title: string;
  comparedToTopicId: string;
  overlap: number;
  reason: string;
}

/** What happened to ONE candidate, and why. Recorded for every topic examined
 *  — accepted, rejected, allowed as an update, deferred or never reached — so
 *  an operator can read the whole selection back afterwards. */
export interface CandidateDecision {
  topicId: string;
  title: string;
  clusterId: string;
  outcome: "accepted" | "accepted-as-update" | "accepted-under-override" | "rejected" | "deferred" | "not-considered";
  relation: EventRelation | "n/a";
  /** The already-selected topic this was judged against, when there was one. */
  comparedToTopicId: string | null;
  /** One sentence, written for a human. */
  reason: string;
  /** The named signals or discriminators behind the verdict. */
  detail: string[];
  /** New developments found, when this was treated as an update. */
  developments: string[];
  stale: boolean;
}

export interface EnforcementResult<T> {
  chosen: T[];
  skipped: DiversitySkip[];
  /** Not dropped — pushed behind everything distinct, and only used if needed. */
  deferred: DiversityDeferral[];
  clusters: EventCluster[];
  /** True when a human override let duplicates through. */
  overrideApplied: boolean;
  /** One entry per candidate, in input order. The audit trail. */
  decisions: CandidateDecision[];
}

export interface EnforcementOptions {
  /** AUTHORIZED human override: keep multiple angles on one event anyway. */
  allowDuplicateEvents?: boolean;
  /** At most this many DUPLICATE-relation topics per event cluster (default 1). */
  maxPerEvent?: number;
  /** Overlap above which a distinct topic is pushed down the order. */
  softOverlapThreshold?: number;
  /** Let a same-event story with a genuine new development through on top of
   *  the per-event allowance. Default true: an update is news, not a rerun. */
  allowUpdates?: boolean;
  /** At most this many updates per event cluster (default 1). */
  maxUpdatesPerEvent?: number;
  /** Day used as "today" for staleness. Defaults to the freshest event date in
   *  the pool, so the decision is deterministic and clock-free. */
  referenceDate?: string | null;
}

/**
 * Walk an ALREADY-RANKED list and take the best `targetCount` topics such that
 * no two are the same event.
 *
 * Three distinct mechanisms, deliberately:
 *  - HARD: a topic whose event is already represented and which carries no new
 *    development is DROPPED, with the reason recorded. This is what makes three
 *    All-Star angles impossible.
 *  - UPDATE: a same-event topic that DOES carry a meaningful new development
 *    (see `classifyEventRelation`) is admitted on top of the per-event
 *    allowance, bounded by `maxUpdatesPerEvent`. A rundown that refuses to
 *    report "and then he was suspended" is not protecting anybody.
 *  - SOFT: a topic that is a different event but overlaps heavily in wording is
 *    DEFERRED to the back of the queue rather than dropped, so a distinct story
 *    never disappears — it just stops sitting next to its nearest neighbour.
 *    Deferred topics are pulled back in (in rank order) if slots remain.
 *
 * STALENESS: a duplicate whose event is more than STALE_EVENT_DAYS behind the
 * freshest event in the pool is blocked even when `maxPerEvent` would have
 * allowed a second angle — an old restatement is the worst thing to spend a
 * slot on. The reference day comes from the pool, never from a clock, so the
 * behaviour is reproducible in CI.
 *
 * Rank order is otherwise preserved: this never promotes a lower-ranked topic
 * above a higher-ranked one that is still distinct.
 */
export function enforceEventDiversity<T extends ClusterableTopic>(
  ranked: T[],
  targetCount: number,
  opts: EnforcementOptions = {}
): EnforcementResult<T> {
  const maxPerEvent = Math.max(1, Math.floor(opts.maxPerEvent ?? 1));
  const maxUpdatesPerEvent = Math.max(0, Math.floor(opts.maxUpdatesPerEvent ?? 1));
  const allowUpdates = opts.allowUpdates !== false;
  const softThreshold = opts.softOverlapThreshold ?? SOFT_OVERLAP_COSINE;
  const target = Math.max(0, Math.floor(targetCount));

  const clustering = clusterTopicsByEvent(ranked);
  const result: EnforcementResult<T> = {
    chosen: [],
    skipped: [],
    deferred: [],
    clusters: clustering.clusters,
    overrideApplied: opts.allowDuplicateEvents === true,
    decisions: [],
  };
  if (target === 0 || ranked.length === 0) {
    // Even a no-op run leaves an audit trail: "nothing was asked for" is a
    // reason an operator may need to read.
    for (const t of ranked) {
      result.decisions.push({
        topicId: t.id,
        title: t.title,
        clusterId: clustering.clusterIdByTopicId[t.id],
        outcome: "not-considered",
        relation: "n/a",
        comparedToTopicId: null,
        reason: "Not examined: this selection asked for zero topics.",
        detail: [],
        developments: [],
        stale: false,
      });
    }
    return result;
  }

  const byId = new Map(ranked.map((t) => [t.id, t]));
  const fp = (t: T) => clustering.fingerprints[t.id];

  // The freshest day anywhere in the pool is "today" for staleness purposes.
  const referenceDate =
    opts.referenceDate ??
    ranked
      .flatMap((t) => clustering.fingerprints[t.id]?.allDates ?? [])
      .sort()
      .at(-1) ??
    null;

  const perCluster = new Map<string, string[]>();
  const updatesPerCluster = new Map<string, number>();
  const deferredQueue: T[] = [];
  const decided = new Set<string>();

  const record = (d: CandidateDecision) => {
    decided.add(d.topicId);
    result.decisions = result.decisions.filter((x) => x.topicId !== d.topicId);
    result.decisions.push(d);
  };

  const takeSlot = (t: T, decision: Omit<CandidateDecision, "topicId" | "title" | "clusterId">) => {
    const cid = clustering.clusterIdByTopicId[t.id];
    perCluster.set(cid, [...(perCluster.get(cid) ?? []), t.id]);
    result.chosen.push(t);
    record({ topicId: t.id, title: t.title, clusterId: cid, ...decision });
  };

  /** Judge a candidate against the topic already holding its event. */
  const judge = (candidate: T, keptId: string) => {
    const kept = byId.get(keptId)!;
    const sim = compareFingerprints(fp(kept), fp(candidate));
    const verdict = classifyEventRelation(fp(kept), fp(candidate), {
      referenceDate,
      sameEvent: true,
    });
    return { kept, sim, verdict };
  };

  const reject = (candidate: T, keptId: string, extra: string) => {
    const cid = clustering.clusterIdByTopicId[candidate.id];
    const { kept, sim, verdict } = judge(candidate, keptId);
    const reasons = explainSimilarity(kept.title, candidate.title, sim);
    result.skipped.push({
      topicId: candidate.id,
      title: candidate.title,
      clusterId: cid,
      duplicateOfTopicId: keptId,
      duplicateOfTitle: kept.title,
      confidence: sim.confidence,
      reasons,
      relation: verdict.relation,
      stale: verdict.stale,
    });
    record({
      topicId: candidate.id,
      title: candidate.title,
      clusterId: cid,
      outcome: "rejected",
      relation: verdict.relation,
      comparedToTopicId: keptId,
      reason: `${verdict.reason} ${extra}`.trim(),
      detail: sim.signals.map((s) => s.detail),
      developments: verdict.developments,
      stale: verdict.stale,
    });
  };

  for (const candidate of ranked) {
    if (result.chosen.length >= target) break;
    const cid = clustering.clusterIdByTopicId[candidate.id];
    const already = perCluster.get(cid) ?? [];

    if (already.length > 0) {
      const keptId = already[0];
      if (opts.allowDuplicateEvents) {
        const { verdict } = judge(candidate, keptId);
        takeSlot(candidate, {
          outcome: "accepted-under-override",
          relation: verdict.relation,
          comparedToTopicId: keptId,
          reason: `Same event as '${byId.get(keptId)!.title}', admitted because allowDuplicateEvents was set by an operator.`,
          detail: [],
          developments: verdict.developments,
          stale: verdict.stale,
        });
        continue;
      }

      const { verdict } = judge(candidate, keptId);
      const updatesTaken = updatesPerCluster.get(cid) ?? 0;

      // An UPDATE is new news, so it is admitted on top of the per-event
      // allowance — but only up to `maxUpdatesPerEvent`.
      if (verdict.relation === "update" && allowUpdates && updatesTaken < maxUpdatesPerEvent) {
        updatesPerCluster.set(cid, updatesTaken + 1);
        takeSlot(candidate, {
          outcome: "accepted-as-update",
          relation: "update",
          comparedToTopicId: keptId,
          reason: verdict.reason,
          detail: verdict.developments,
          developments: verdict.developments,
          stale: verdict.stale,
        });
        continue;
      }
      if (verdict.relation === "update" && !allowUpdates) {
        reject(candidate, keptId, "Updates are disabled for this build (allowUpdates=false).");
        continue;
      }
      if (verdict.relation === "update") {
        reject(candidate, keptId, `This event already carries ${maxUpdatesPerEvent} update(s).`);
        continue;
      }
      // A stale duplicate is blocked even when the per-event allowance has room.
      if (verdict.stale) {
        reject(
          candidate,
          keptId,
          `The event is more than ${STALE_EVENT_DAYS} days behind the freshest story in the pool, so a second angle on it is not worth a slot.`
        );
        continue;
      }
      if (already.length >= maxPerEvent) {
        reject(candidate, keptId, `This event already holds its allowance of ${maxPerEvent} topic(s).`);
        continue;
      }
      // Within the allowance: a second angle on one event was explicitly asked for.
      takeSlot(candidate, {
        outcome: "accepted",
        relation: verdict.relation,
        comparedToTopicId: keptId,
        reason: `Second angle on the same event, permitted by maxPerEvent=${maxPerEvent}.`,
        detail: [],
        developments: [],
        stale: verdict.stale,
      });
      continue;
    }

    // SOFT: distinct event, but reads too much like something already chosen.
    const worst = result.chosen.reduce<{ id: string; overlap: number } | null>((acc, c) => {
      const sim = compareFingerprints(fp(c), fp(candidate));
      if (!acc || sim.overlap > acc.overlap) return { id: c.id, overlap: sim.overlap };
      return acc;
    }, null);
    if (worst && worst.overlap >= softThreshold && !opts.allowDuplicateEvents) {
      deferredQueue.push(candidate);
      const reason = `Deferred behind distinct stories: ${Math.round(worst.overlap * 100)}% overlap with '${byId.get(worst.id)!.title}' (different event, so kept — just not adjacent).`;
      result.deferred.push({
        topicId: candidate.id,
        title: candidate.title,
        comparedToTopicId: worst.id,
        overlap: worst.overlap,
        reason,
      });
      record({
        topicId: candidate.id,
        title: candidate.title,
        clusterId: cid,
        outcome: "deferred",
        relation: "distinct",
        comparedToTopicId: worst.id,
        reason,
        detail: [],
        developments: [],
        stale: false,
      });
      continue;
    }

    takeSlot(candidate, {
      outcome: "accepted",
      relation: result.chosen.length === 0 ? "n/a" : "distinct",
      comparedToTopicId: null,
      reason: "Distinct event — nothing already in the rundown is the same story.",
      detail: [],
      developments: [],
      stale: false,
    });
  }

  // Backfill from the deferred queue, still respecting the hard event rule. A
  // deferred topic whose event filled up while it waited is now a real drop, so
  // it moves from `deferred` to `skipped` — the operator must never be shown a
  // topic as "held back" when it was actually removed.
  for (const candidate of deferredQueue) {
    const cid = clustering.clusterIdByTopicId[candidate.id];
    const already = perCluster.get(cid) ?? [];
    if (already.length >= maxPerEvent) {
      result.deferred = result.deferred.filter((d) => d.topicId !== candidate.id);
      reject(candidate, already[0], "Its event filled up while it waited behind the distinct stories.");
      continue;
    }
    if (result.chosen.length >= target) continue;
    result.deferred = result.deferred.filter((d) => d.topicId !== candidate.id);
    takeSlot(candidate, {
      outcome: "accepted",
      relation: "distinct",
      comparedToTopicId: null,
      reason: "Pulled back in from the deferred queue — a slot remained and it is a distinct event.",
      detail: [],
      developments: [],
      stale: false,
    });
  }

  // Everything the walk never reached still gets a line in the audit trail.
  for (const candidate of ranked) {
    if (decided.has(candidate.id)) continue;
    result.decisions.push({
      topicId: candidate.id,
      title: candidate.title,
      clusterId: clustering.clusterIdByTopicId[candidate.id],
      outcome: "not-considered",
      relation: "n/a",
      comparedToTopicId: null,
      reason: `Not examined: the rundown was already full at ${target} topic(s) when this candidate came up.`,
      detail: [],
      developments: [],
      stale: false,
    });
  }
  const order = new Map(ranked.map((t, i) => [t.id, i]));
  result.decisions.sort((x, y) => (order.get(x.topicId) ?? 0) - (order.get(y.topicId) ?? 0));

  return result;
}

// ---------------------------------------------------------------------------
// Whole-rundown scoring
// ---------------------------------------------------------------------------

export interface RundownDiversityAxes {
  /** Variety of the central QUESTION each topic asks (title vocabulary). */
  centralQuestion: number;
  /** Variety of the CONSEQUENCE argued (summary + angle vocabulary). */
  consequence: number;
  /** Variety of the PRINCIPAL PEOPLE involved. */
  people: number;
  /** Variety of the EVIDENCE cited. */
  evidence: number;
}

export interface RundownPairReport {
  topicIdA: string;
  topicIdB: string;
  titleA: string;
  titleB: string;
  lexicalCosine: number;
  entityJaccard: number;
  evidenceJaccard: number;
  /** Concept-expanded cosine — the offline semantic signal. */
  conceptCosine: number;
  /** Weight of the claim atoms both topics assert. */
  claimSharedWeight: number;
  /** The atoms themselves, for an operator scanning the report. */
  sharedClaimAtoms: string[];
  sameEvent: boolean;
  reasons: string[];
  /** Present when the pair LOOKED alike but a discriminator settled it. */
  discriminators: string[];
}

export interface RundownDiversityReport {
  /** No two topics are the same event AND the score clears the threshold. */
  passed: boolean;
  /** 0..100, higher = more varied. */
  score: number;
  topicCount: number;
  /** Distinct events represented. Equal to topicCount in a healthy rundown. */
  clusterCount: number;
  axes: RundownDiversityAxes;
  clusters: EventCluster[];
  /** Clusters holding more than one selected topic — the actual failure. */
  duplicateClusters: Array<{ clusterId: string; label: string; topicIds: string[]; anchors: string[] }>;
  pairs: RundownPairReport[];
  warnings: string[];
}

/**
 * Score the COMPLETE rundown rather than each topic on its own. A rundown of
 * three individually-excellent topics that are three angles on one event is a
 * bad rundown, and nothing that looks at topics one at a time can see that.
 */
export function scoreRundownDiversity(selectedTopics: ClusterableTopic[]): RundownDiversityReport {
  const clustering = clusterTopicsByEvent(selectedTopics);
  const fps = selectedTopics.map((t) => clustering.fingerprints[t.id]);
  const titleById = new Map(selectedTopics.map((t) => [t.id, t.title]));

  const pairs: RundownPairReport[] = [];
  const warnings: string[] = [];
  let questionSim = 0;
  let consequenceSim = 0;
  let peopleSim = 0;
  let evidenceSim = 0;
  let pairCount = 0;

  for (let i = 0; i < selectedTopics.length; i++) {
    for (let j = i + 1; j < selectedTopics.length; j++) {
      const a = fps[i];
      const b = fps[j];
      const sim = compareFingerprints(a, b);
      pairCount++;
      questionSim += sim.titleCosine;
      consequenceSim += sim.lexicalCosine;
      peopleSim += jaccard(a.people.length || b.people.length ? a.people : a.entities,
                           a.people.length || b.people.length ? b.people : b.entities);
      evidenceSim += sim.evidenceJaccard;
      pairs.push({
        topicIdA: a.topicId,
        topicIdB: b.topicId,
        titleA: titleById.get(a.topicId) ?? a.title,
        titleB: titleById.get(b.topicId) ?? b.title,
        lexicalCosine: sim.lexicalCosine,
        entityJaccard: sim.entityJaccard,
        evidenceJaccard: sim.evidenceJaccard,
        conceptCosine: sim.conceptCosine,
        claimSharedWeight: sim.claim.sharedWeight,
        sharedClaimAtoms: sim.claim.sharedAtoms.map((x) => x.atom),
        sameEvent: sim.sameEvent,
        reasons: sim.sameEvent ? sim.signals.map((s) => s.detail) : [],
        discriminators: sim.discriminators.map((d) => `${d.code}: ${d.detail}`),
      });
      if (sim.sameEvent) {
        warnings.push(
          `'${titleById.get(a.topicId)}' and '${titleById.get(b.topicId)}' are the same event: ${sim.signals.map((s) => s.detail).join("; ")}.`
        );
      } else if (sim.overlap >= SOFT_OVERLAP_COSINE) {
        warnings.push(
          `'${titleById.get(a.topicId)}' and '${titleById.get(b.topicId)}' overlap ${Math.round(sim.overlap * 100)}% without being the same event — consider separating them in the running order.`
        );
      }
    }
  }

  const axes: RundownDiversityAxes = pairCount === 0
    ? { centralQuestion: 1, consequence: 1, people: 1, evidence: 1 }
    : {
        centralQuestion: 1 - questionSim / pairCount,
        consequence: 1 - consequenceSim / pairCount,
        people: 1 - peopleSim / pairCount,
        evidence: 1 - evidenceSim / pairCount,
      };

  const duplicateClusters = clustering.clusters
    .filter((c) => c.topicIds.length > 1)
    .map((c) => ({ clusterId: c.id, label: c.label, topicIds: c.topicIds, anchors: c.anchors }));

  const eventVariety = selectedTopics.length === 0
    ? 1
    : clustering.clusters.length / selectedTopics.length;

  // Event variety dominates: a rundown that is one event three ways cannot be
  // rescued by varied wording.
  const raw =
    0.5 * eventVariety +
    0.2 * axes.centralQuestion +
    0.15 * axes.consequence +
    0.075 * axes.people +
    0.075 * axes.evidence;
  const score = Math.round(Math.max(0, Math.min(1, raw)) * 100);

  return {
    passed: duplicateClusters.length === 0 && score >= RUNDOWN_DIVERSITY_THRESHOLD,
    score,
    topicCount: selectedTopics.length,
    clusterCount: clustering.clusters.length,
    axes,
    clusters: clustering.clusters,
    duplicateClusters,
    pairs,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Optional enrichment
// ---------------------------------------------------------------------------

/** The narrow DB surface enrichment uses. Feature-detected, never required. */
interface EnrichmentDb {
  game?: { findMany?: (args: unknown) => Promise<Array<Record<string, unknown>>> };
  newsItem?: { findMany?: (args: unknown) => Promise<Array<Record<string, unknown>>> };
}

/**
 * Resolve the Game and NewsItem rows referenced by a topic pool so clustering
 * can see real teams, kickoff dates, and article URLs instead of only the words
 * in a headline.
 *
 * BEST EFFORT BY DESIGN: the tables are feature-detected and every failure is
 * swallowed. Clustering degrades to text+refs rather than breaking selection,
 * and the many in-memory test doubles that implement only `topicCandidate`
 * keep working untouched.
 */
export async function loadEventContext(
  dbi: unknown,
  topics: ClusterableTopic[]
): Promise<Map<string, TopicEventContext>> {
  const out = new Map<string, TopicEventContext>();
  const db = dbi as EnrichmentDb | null;
  if (!db) return out;

  const refsByTopic = new Map<string, { games: string[]; news: string[] }>();
  const allGameIds = new Set<string>();
  const allNewsIds = new Set<string>();
  for (const t of topics) {
    const keys = [
      ...evidenceKeysOf(t.evidenceIds),
      ...evidenceKeysOf(t.researchBrief?.sourceIds),
    ];
    const games = keys.filter((k) => k.startsWith("game:")).map((k) => k.slice(5));
    const news = keys.filter((k) => k.startsWith("newsItem:")).map((k) => k.slice(9));
    if (games.length === 0 && news.length === 0) continue;
    refsByTopic.set(t.id, { games, news });
    for (const g of games) allGameIds.add(g);
    for (const n of news) allNewsIds.add(n);
  }
  if (refsByTopic.size === 0) return out;

  const gameRows = new Map<string, Record<string, unknown>>();
  const newsRows = new Map<string, Record<string, unknown>>();

  if (allGameIds.size > 0 && typeof db.game?.findMany === "function") {
    try {
      const rows = await db.game.findMany({
        where: { id: { in: [...allGameIds] } },
        select: { id: true, leagueId: true, homeTeamId: true, awayTeamId: true, scheduledAt: true },
      });
      for (const r of rows ?? []) if (typeof r?.id === "string") gameRows.set(r.id, r);
    } catch {
      /* enrichment is optional — fall back to text + refs */
    }
  }
  if (allNewsIds.size > 0 && typeof db.newsItem?.findMany === "function") {
    try {
      const rows = await db.newsItem.findMany({
        where: { id: { in: [...allNewsIds] } },
        select: { id: true, title: true, url: true, publishedAt: true, entities: true },
      });
      for (const r of rows ?? []) if (typeof r?.id === "string") newsRows.set(r.id, r);
    } catch {
      /* enrichment is optional — fall back to text + refs */
    }
  }
  if (gameRows.size === 0 && newsRows.size === 0) return out;

  for (const [topicId, refs] of refsByTopic) {
    const games = refs.games.map((id) => gameRows.get(id)).filter(Boolean) as Array<Record<string, unknown>>;
    const news = refs.news.map((id) => newsRows.get(id)).filter(Boolean) as Array<Record<string, unknown>>;
    if (games.length === 0 && news.length === 0) continue;
    out.set(topicId, {
      games: games.map((g) => ({
        id: String(g.id),
        leagueId: (g.leagueId as string | null) ?? null,
        homeTeamId: (g.homeTeamId as string | null) ?? null,
        awayTeamId: (g.awayTeamId as string | null) ?? null,
        scheduledAt: (g.scheduledAt as Date | string | null) ?? null,
      })),
      newsItems: news.map((n) => ({
        id: String(n.id),
        title: (n.title as string | null) ?? null,
        url: (n.url as string | null) ?? null,
        publishedAt: (n.publishedAt as Date | string | null) ?? null,
        entities: n.entities,
      })),
    });
  }
  return out;
}
