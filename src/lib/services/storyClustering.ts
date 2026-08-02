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
//  - Fully offline and deterministic: no network, no API keys, no model calls.
//    Everything here is classical lexical semantics (stopword stripping, light
//    stemming, cosine over token vectors, Jaccard over entity/evidence sets)
//    plus the hard identifiers the schema actually carries.
//  - Only REAL schema fields are read: TopicCandidate.{title, summary, sport,
//    leagueId, evidenceIds, createdAt}, ResearchBrief.{facts, sourceIds,
//    mainAngle, contrarianAngle, argumentForHostA/B}, TopicSource.{canonicalUrl,
//    originalUrl, publishedAt, title}, and — when a caller enriches — Game.{id,
//    homeTeamId, awayTeamId, scheduledAt, leagueId} and NewsItem.{id, url,
//    publishedAt, entities, title}.
//  - Every merge must be EXPLAINABLE. See THE ANCHOR RULE below.
//
// THE ANCHOR RULE (the central editorial trade-off, stated plainly)
// ----------------------------------------------------------------
// Two topics are only ever declared the same event when this module can NAME
// the thing they share: a shared Game id, a shared piece of evidence, a shared
// article URL, a shared team-pair-plus-date, or at least two shared named
// entities. Pure "these two blobs of prose look alike" is deliberately NOT
// sufficient on its own.
//
// The cost of that choice, honestly: a pair of topics carrying no identifiable
// entities at all (no proper nouns, no shared evidence, no game) can never be
// merged, no matter how similar their wording. In production that shape does
// not occur — a real sports topic always names somebody — but it means this
// module is tuned for PRECISION over recall. A false merge silently deletes a
// legitimate story from the rundown and no operator would ever see the story
// that wasn't there; a missed merge is visible in the finished episode and is
// also caught downstream by `scoreRundownDiversity`. Those two failure modes
// are not symmetric, so the thresholds are not symmetric either.

import crypto from "crypto";

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
}

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

const STOPWORDS = new Set<string>([
  "a", "about", "after", "again", "against", "all", "am", "an", "and", "any", "are", "aren",
  "as", "at", "be", "became", "because", "been", "before", "being", "below", "between", "both",
  "but", "by", "can", "cant", "could", "couldnt", "did", "didnt", "do", "does", "doesnt", "doing",
  "dont", "down", "during", "each", "few", "for", "from", "further", "get", "gets", "got", "had",
  "has", "hasnt", "have", "havent", "having", "he", "her", "here", "hers", "him", "his", "how",
  "i", "if", "in", "into", "is", "isnt", "it", "its", "just", "like", "made", "make", "makes",
  "me", "might", "more", "most", "much", "must", "my", "never", "no", "nor", "not", "now", "of",
  "off", "on", "once", "one", "only", "or", "other", "our", "out", "over", "own", "really", "s",
  "same", "say", "says", "she", "should", "so", "some", "still", "such", "t", "than", "that",
  "the", "their", "theirs", "them", "then", "there", "these", "they", "this", "those", "through",
  "to", "too", "under", "until", "up", "very", "was", "wasnt", "we", "were", "what", "when",
  "where", "which", "while", "who", "whom", "why", "will", "with", "would", "you", "your", "yours",
  // Question scaffolding: every generated topic title is a question, so these
  // carry no information about WHICH story a topic is.
  "did", "does", "is", "are", "was", "were", "should", "could", "can", "has", "have", "will",
  "just", "real", "actually", "even",
]);

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

/** Very light suffix stripper — enough to fold pitcher/pitchers, shut/shutout
 *  style variants together without dragging in a real stemmer dependency. */
export function stemWord(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("sses")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("ss")) return w;
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("us")) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  if (w.length > 4 && w.endsWith("er")) w = w.slice(0, -2);
  return w;
}

/** Case/punctuation/spacing-insensitive headline form (matches the generator's
 *  own normalizeTitle contract in topicIngestion.ts). */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9'-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Stopword-stripped, stemmed content tokens. Hyphenated compounds are kept
 *  whole ("all-star") AND split, so "All-Star" matches "all star". */
export function contentTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const raw of normalizeText(text).split(" ")) {
    if (!raw) continue;
    const bare = raw.replace(/'/g, "");
    if (bare.includes("-")) {
      const joined = bare.replace(/-/g, "");
      if (joined.length > 2 && !STOPWORDS.has(joined)) out.push(stemWord(joined));
      for (const part of bare.split("-")) {
        if (part.length > 2 && !STOPWORDS.has(part)) out.push(stemWord(part));
      }
      continue;
    }
    if (bare.length < 2) continue;
    if (STOPWORDS.has(bare)) continue;
    if (/^\d+$/.test(bare) && bare.length < 3) continue;
    out.push(stemWord(bare));
  }
  return out;
}

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

function toDayString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
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
  /** Capitalized-run entities from the title/summary/news entities. */
  entities: string[];
  /** The subset of `entities` that read as a person's name. */
  people: string[];
  /** "type:id" evidence + brief-source refs. */
  evidenceKeys: string[];
  /** Normalized article URLs from TopicSource / NewsItem / brief JSON. */
  sourceUrls: string[];
  /** Stopword-stripped stemmed title tokens. */
  titleTokens: string[];
  /** Title (double weighted) + summary + brief angles tokens. */
  textTokens: string[];
  /** sha1 over the sorted unique title tokens — stable across rewordings that
   *  only reorder or repunctuate. */
  titleFingerprint: string;
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
  const sourceUrls = new Set<string>();

  for (const g of topic.eventContext?.games ?? []) {
    if (g.id) gameIds.add(g.id);
    if (g.homeTeamId) teamIds.add(g.homeTeamId);
    if (g.awayTeamId) teamIds.add(g.awayTeamId);
    const day = toDayString(g.scheduledAt);
    if (day) eventDates.add(day);
  }

  const entityBag = new Set<string>();
  const peopleBag = new Set<string>();

  const absorbText = (text: string | null | undefined) => {
    const { entities, people } = extractEntities(text);
    for (const e of entities) entityBag.add(e);
    for (const p of people) peopleBag.add(p);
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
        if (typeof e === "string" && e.trim().length >= 3) entityBag.add(e.trim().toLowerCase());
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

  collectUrlsFromJson(brief?.sourceIds, sourceUrls);
  collectUrlsFromJson(brief?.facts, sourceUrls);

  const league = (topic.leagueId || topic.sport || "").trim().toUpperCase() || null;
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

  const titleFingerprint = crypto
    .createHash("sha1")
    .update([...new Set(titleTokens)].sort().join("|"))
    .digest("hex")
    .slice(0, 16);

  const sortedGames = [...gameIds].sort();
  const sortedTeams = [...teamIds].sort();
  const sortedDates = [...eventDates].sort();

  // The composite key prefers the strongest durable anchor present.
  const key = sortedGames.length > 0
    ? `game:${sortedGames.join("+")}`
    : sortedTeams.length > 0 && sortedDates.length > 0
      ? `teams:${sortedTeams.join("+")}@${sortedDates[0]}`
      : `${league ?? "-"}:title:${titleFingerprint}`;

  return {
    topicId: topic.id,
    title: topic.title,
    league,
    gameIds: sortedGames,
    teamIds: sortedTeams,
    eventDates: sortedDates,
    entities: [...entityBag].sort(),
    people: [...peopleBag].sort(),
    evidenceKeys: [...evidenceKeys].sort(),
    sourceUrls: [...sourceUrls].sort(),
    titleTokens,
    textTokens,
    titleFingerprint,
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
  | "semantic_overlap";

export interface DuplicateSignal {
  code: DuplicateSignalCode;
  /** Operator-readable, names the shared thing. */
  detail: string;
  /** 0..1 — how conclusive this signal is on its own. */
  weight: number;
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
  sharedGameIds: string[];
  sharedEntities: string[];
  sharedEvidenceKeys: string[];
  sharedSourceUrls: string[];
  sharedTeamIds: string[];
  sharedDates: string[];
  /** True only when a NAMED anchor supports the merge (see THE ANCHOR RULE). */
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

  const lexicalCosine = cosineSimilarity(a.textTokens, b.textTokens);
  const titleCosine = cosineSimilarity(a.titleTokens, b.titleTokens);
  const entityJaccard = jaccard(a.entities, b.entities);
  const peopleJaccard = jaccard(a.people, b.people);
  const evidenceJaccard = jaccard(
    [...a.evidenceKeys, ...a.sourceUrls],
    [...b.evidenceKeys, ...b.sourceUrls]
  );

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
    lexicalCosine >= SEMANTIC_SAME_EVENT_COSINE &&
    entityJaccard >= SEMANTIC_SAME_EVENT_ENTITY_JACCARD &&
    sharedEntities.length >= 2 &&
    (a.league == null || b.league == null || a.league === b.league)
  ) {
    signals.push({
      code: "semantic_overlap",
      detail: `${Math.round(lexicalCosine * 100)}% wording overlap and ${Math.round(entityJaccard * 100)}% entity overlap (shared: ${sharedEntities.slice(0, 4).join(", ")})`,
      weight: 0.8,
    });
  }

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
    sharedGameIds,
    sharedEntities,
    sharedEvidenceKeys,
    sharedSourceUrls,
    sharedTeamIds,
    sharedDates,
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
  const sim = compareTopics(a, b);
  if (sim.signals.length === 0) {
    const near: string[] = [];
    if (sim.lexicalCosine > 0) near.push(`${Math.round(sim.lexicalCosine * 100)}% wording overlap`);
    if (sim.entityJaccard > 0) near.push(`${Math.round(sim.entityJaccard * 100)}% entity overlap`);
    if (sim.sharedEvidenceKeys.length > 0) near.push(`${sim.sharedEvidenceKeys.length} shared evidence ref(s)`);
    return [
      near.length > 0
        ? `Different events: ${near.join(", ")} — below the bar for a merge, and no shared game, article, or entity pair to name.`
        : "Different events: nothing shared — no game, article, evidence, entity, or wording overlap.",
    ];
  }
  const head = `'${a.title}' and '${b.title}' look like the same event (${Math.round(sim.confidence * 100)}% confidence):`;
  return [head, ...sim.signals.map((s) => `- ${s.detail}`)];
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
    const label = sharedGames.length > 0
      ? `game ${sharedGames[0]}`
      : sharedEnt.length > 0
        ? sharedEnt.slice(0, 3).join(" / ")
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
}

export interface DiversityDeferral {
  topicId: string;
  title: string;
  comparedToTopicId: string;
  overlap: number;
  reason: string;
}

export interface EnforcementResult<T> {
  chosen: T[];
  skipped: DiversitySkip[];
  /** Not dropped — pushed behind everything distinct, and only used if needed. */
  deferred: DiversityDeferral[];
  clusters: EventCluster[];
  /** True when a human override let duplicates through. */
  overrideApplied: boolean;
}

export interface EnforcementOptions {
  /** AUTHORIZED human override: keep multiple angles on one event anyway. */
  allowDuplicateEvents?: boolean;
  /** At most this many topics per event cluster (default 1). */
  maxPerEvent?: number;
  /** Overlap above which a distinct topic is pushed down the order. */
  softOverlapThreshold?: number;
}

/**
 * Walk an ALREADY-RANKED list and take the best `targetCount` topics such that
 * no two are the same event.
 *
 * Two distinct mechanisms, deliberately:
 *  - HARD: a topic whose event is already represented is DROPPED, with the
 *    reason recorded. This is what makes three All-Star angles impossible.
 *  - SOFT: a topic that is a different event but overlaps heavily in wording is
 *    DEFERRED to the back of the queue rather than dropped, so a distinct story
 *    never disappears — it just stops sitting next to its nearest neighbour.
 *    Deferred topics are pulled back in (in rank order) if slots remain.
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
  const softThreshold = opts.softOverlapThreshold ?? SOFT_OVERLAP_COSINE;
  const target = Math.max(0, Math.floor(targetCount));

  const clustering = clusterTopicsByEvent(ranked);
  const result: EnforcementResult<T> = {
    chosen: [],
    skipped: [],
    deferred: [],
    clusters: clustering.clusters,
    overrideApplied: opts.allowDuplicateEvents === true,
  };
  if (target === 0 || ranked.length === 0) return result;

  const byId = new Map(ranked.map((t) => [t.id, t]));
  const fp = (t: T) => clustering.fingerprints[t.id];

  const perCluster = new Map<string, string[]>();
  const deferredQueue: T[] = [];

  const takeSlot = (t: T) => {
    const cid = clustering.clusterIdByTopicId[t.id];
    perCluster.set(cid, [...(perCluster.get(cid) ?? []), t.id]);
    result.chosen.push(t);
  };

  for (const candidate of ranked) {
    if (result.chosen.length >= target) break;
    const cid = clustering.clusterIdByTopicId[candidate.id];
    const already = perCluster.get(cid) ?? [];

    if (already.length >= maxPerEvent) {
      const keptId = already[0];
      const kept = byId.get(keptId)!;
      if (opts.allowDuplicateEvents) {
        takeSlot(candidate);
        continue;
      }
      const sim = compareFingerprints(fp(kept), fp(candidate));
      result.skipped.push({
        topicId: candidate.id,
        title: candidate.title,
        clusterId: cid,
        duplicateOfTopicId: keptId,
        duplicateOfTitle: kept.title,
        confidence: sim.confidence,
        reasons: explainDuplicate(kept, candidate),
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
      result.deferred.push({
        topicId: candidate.id,
        title: candidate.title,
        comparedToTopicId: worst.id,
        overlap: worst.overlap,
        reason: `Deferred behind distinct stories: ${Math.round(worst.overlap * 100)}% overlap with '${byId.get(worst.id)!.title}' (different event, so kept — just not adjacent).`,
      });
      continue;
    }

    takeSlot(candidate);
  }

  // Backfill from the deferred queue, still respecting the hard event rule. A
  // deferred topic whose event filled up while it waited is now a real drop, so
  // it moves from `deferred` to `skipped` — the operator must never be shown a
  // topic as "held back" when it was actually removed.
  for (const candidate of deferredQueue) {
    const cid = clustering.clusterIdByTopicId[candidate.id];
    const already = perCluster.get(cid) ?? [];
    if (already.length >= maxPerEvent) {
      const keptId = already[0];
      const kept = byId.get(keptId)!;
      const sim = compareFingerprints(fp(kept), fp(candidate));
      result.deferred = result.deferred.filter((d) => d.topicId !== candidate.id);
      result.skipped.push({
        topicId: candidate.id,
        title: candidate.title,
        clusterId: cid,
        duplicateOfTopicId: keptId,
        duplicateOfTitle: kept.title,
        confidence: sim.confidence,
        reasons: explainDuplicate(kept, candidate),
      });
      continue;
    }
    if (result.chosen.length >= target) continue;
    takeSlot(candidate);
  }

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
  sameEvent: boolean;
  reasons: string[];
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
        sameEvent: sim.sameEvent,
        reasons: sim.sameEvent ? sim.signals.map((s) => s.detail) : [],
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
