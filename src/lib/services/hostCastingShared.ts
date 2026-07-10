// Client-safe host-casting helpers: pure functions with no DB import, so they
// ship to the browser and to unit tests without pulling server-only env.
// The DB-backed resolver lives in ./hostCasting.

export interface CastHost {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Topic-aware fit scoring (Task 3).
//
// Goal: when an episode has NOT pinned a cast, pick the two hosts who (a) both
// have a real stake in this specific topic and (b) will actually disagree —
// instead of blindly taking the two most intense (which is how a betting-market
// persona got cast onto a baseball-nostalgia debate). Pinned hostIds remain an
// absolute override; this only informs the fallback.
//
// v1 uses transparent keyword/term overlap over data we already store — no
// embeddings, no schema change.
//
// SCORING FORMULA (all terms are lowercased, de-pluralized keyword sets):
//   topicTerms   = sport + league + title + summary
//   angleMain    = researchBrief.mainAngle
//   angleContra  = researchBrief.contrarianAngle
//   host FOR     = worldview + likes + argumentPatterns   (what pulls them in)
//   host AGAINST = dislikes                                (what provokes them)
//
//   fit(h)  = overlap(FOR, topic∪angles) + 0.5·overlap(AGAINST, topic∪angles)
//             — engagement: a host provoked by the topic still has a stake,
//               weighted a little lower than positive affinity.
//   lean(h) = [overlap(FOR,main) − overlap(AGAINST,main)]
//           − [overlap(FOR,contra) − overlap(AGAINST,contra)]
//             — signed: >0 leans the main angle, <0 leans the contrarian angle.
//
//   OPPOSITION(A,B) = |lean(A) − lean(B)|            (angle disagreement on THIS topic)
//                   + 0.5·clash(A,B)                 (intrinsic persona conflict)
//     clash(A,B)    = overlap(A.likes, B.dislikes) + overlap(B.likes, A.dislikes)
//                     — one host loves exactly what the other can't stand.
//
//   pairScore(A,B) = fit(A) + fit(B) + OPPOSITION(A,B)
//     HARD GATE: both fit(A) and fit(B) ≥ MIN_STAKE, else the pair is
//     disqualified. If no pair clears the gate (sparse topic / no brief) the
//     caller falls back to today's intensity-sorted behavior.
// ---------------------------------------------------------------------------

export interface CastingTopicInput {
  sport?: string | null;
  leagueId?: string | null;
  leagueName?: string | null;
  title?: string | null;
  summary?: string | null;
}

export interface CastingBriefInput {
  mainAngle?: string | null;
  contrarianAngle?: string | null;
}

/** Everything scoreHostFit needs from a host — a superset of the AiHost row. */
export interface ScorableHost {
  id: string;
  name: string;
  worldview?: string | null;
  likes?: unknown; // Json string[]
  dislikes?: unknown; // Json string[]
  argumentPatterns?: unknown; // Json (string | object)[]
  intensityLevel?: number | null;
}

/** At least one shared term required for a host to "have a stake." */
export const MIN_STAKE = 1;
/** Weight on being provoked (dislike overlap) vs. drawn in (like overlap). */
const AGAINST_WEIGHT = 0.5;
/** Weight on intrinsic persona clash within the opposition term. */
const CLASH_WEIGHT = 0.5;

const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "was", "our",
  "out", "who", "why", "how", "what", "when", "with", "this", "that", "then",
  "they", "them", "from", "into", "about", "over", "than", "more", "most",
  "your", "will", "just", "some", "one", "two", "its", "his", "her", "their",
  "have", "has", "had", "been", "being", "does", "did", "can", "could", "would",
  "should", "a", "an", "of", "to", "is", "in", "on", "it", "or", "as", "at",
  "by", "be", "we", "up", "so", "no", "if",
]);

/** Lowercase, split on non-alphanumerics, drop stopwords/short tokens, and
 *  crudely de-pluralize so "rings"→"ring", "models"→"model" match. */
export function terms(text: unknown): Set<string> {
  const out = new Set<string>();
  if (text == null) return out;
  const raw = String(text).toLowerCase();
  for (const tok of raw.split(/[^a-z0-9]+/)) {
    if (tok.length < 3 || STOPWORDS.has(tok)) continue;
    const singular = tok.length > 3 && tok.endsWith("s") ? tok.slice(0, -1) : tok;
    out.add(singular);
  }
  return out;
}

/** Coerce a Json likes/dislikes/argumentPatterns value into flat text. */
function jsonToText(v: unknown): string {
  if (Array.isArray(v)) {
    return v
      .map((item) =>
        item && typeof item === "object" ? Object.values(item).join(" ") : String(item)
      )
      .join(" ");
  }
  if (v && typeof v === "object") return Object.values(v).join(" ");
  return v == null ? "" : String(v);
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

/** Pre-tokenized view of a host, so pair scoring never re-tokenizes. */
interface HostTerms {
  host: ScorableHost;
  forTerms: Set<string>;
  againstTerms: Set<string>;
  likeTerms: Set<string>;
  dislikeTerms: Set<string>;
}

function tokenizeHost(h: ScorableHost): HostTerms {
  const likeTerms = terms(jsonToText(h.likes));
  const dislikeTerms = terms(jsonToText(h.dislikes));
  const forTerms = new Set<string>([
    ...terms(h.worldview),
    ...likeTerms,
    ...terms(jsonToText(h.argumentPatterns)),
  ]);
  return { host: h, forTerms, againstTerms: dislikeTerms, likeTerms, dislikeTerms };
}

export interface HostFit {
  hostId: string;
  name: string;
  fit: number;
  lean: number;
  forHits: number;
  againstHits: number;
}

interface TopicTermBags {
  topicAll: Set<string>;
  main: Set<string>;
  contra: Set<string>;
}

function topicBags(topic: CastingTopicInput, brief?: CastingBriefInput): TopicTermBags {
  const main = terms(brief?.mainAngle);
  const contra = terms(brief?.contrarianAngle);
  const topicAll = new Set<string>([
    ...terms(topic.sport),
    ...terms(topic.leagueId),
    ...terms(topic.leagueName),
    ...terms(topic.title),
    ...terms(topic.summary),
    ...main,
    ...contra,
  ]);
  return { topicAll, main, contra };
}

function fitOf(ht: HostTerms, bags: TopicTermBags): HostFit {
  const forHits = overlap(ht.forTerms, bags.topicAll);
  const againstHits = overlap(ht.againstTerms, bags.topicAll);
  const fit = forHits + AGAINST_WEIGHT * againstHits;
  const leanMain = overlap(ht.forTerms, bags.main) - overlap(ht.againstTerms, bags.main);
  const leanContra = overlap(ht.forTerms, bags.contra) - overlap(ht.againstTerms, bags.contra);
  return {
    hostId: ht.host.id,
    name: ht.host.name,
    fit,
    lean: leanMain - leanContra,
    forHits,
    againstHits,
  };
}

/** Public per-host fit (used by the report/test script). */
export function scoreHostFit(
  host: ScorableHost,
  topic: CastingTopicInput,
  brief?: CastingBriefInput
): HostFit {
  return fitOf(tokenizeHost(host), topicBags(topic, brief));
}

export interface PairFit {
  a: HostFit;
  b: HostFit;
  opposition: number;
  leanSpread: number;
  clash: number;
  pairScore: number;
}

export interface BestPairResult {
  /** Indices into the input host array, hostA-chair first (higher intensity). */
  aIndex: number;
  bIndex: number;
  pair: PairFit;
  /** Every stake-qualified pair, best first — for reporting/inspection. */
  ranked: PairFit[];
}

/**
 * Choose the best-fit oppositional pair from a roster for a topic. Returns null
 * when fewer than two hosts, or when no pair clears the stake gate (the caller
 * should then fall back to intensity-sorted selection).
 */
export function selectBestPair(
  hosts: ScorableHost[],
  topic: CastingTopicInput,
  brief?: CastingBriefInput
): BestPairResult | null {
  if (hosts.length < 2) return null;
  const bags = topicBags(topic, brief);
  const tokenized = hosts.map(tokenizeHost);
  const fits = tokenized.map((ht) => fitOf(ht, bags));

  const ranked: Array<PairFit & { i: number; j: number }> = [];
  for (let i = 0; i < hosts.length; i++) {
    for (let j = i + 1; j < hosts.length; j++) {
      if (fits[i].fit < MIN_STAKE || fits[j].fit < MIN_STAKE) continue; // both need a stake
      const leanSpread = Math.abs(fits[i].lean - fits[j].lean);
      const clash =
        overlap(tokenized[i].likeTerms, tokenized[j].dislikeTerms) +
        overlap(tokenized[j].likeTerms, tokenized[i].dislikeTerms);
      const opposition = leanSpread + CLASH_WEIGHT * clash;
      const pairScore = fits[i].fit + fits[j].fit + opposition;
      ranked.push({ a: fits[i], b: fits[j], opposition, leanSpread, clash, pairScore, i, j });
    }
  }
  if (ranked.length === 0) return null;

  ranked.sort((p, q) => {
    if (q.pairScore !== p.pairScore) return q.pairScore - p.pairScore;
    // Deterministic tie-breaks: more opposition, then combined intensity, names.
    if (q.opposition !== p.opposition) return q.opposition - p.opposition;
    const iP = (hosts[p.i].intensityLevel ?? 0) + (hosts[p.j].intensityLevel ?? 0);
    const iQ = (hosts[q.i].intensityLevel ?? 0) + (hosts[q.j].intensityLevel ?? 0);
    if (iQ !== iP) return iQ - iP;
    return `${p.a.name}${p.b.name}`.localeCompare(`${q.a.name}${q.b.name}`);
  });

  const best = ranked[0];
  // Chair convention: higher-intensity host keeps the A ("emotional") chair,
  // matching the existing resolver so rendering/seating stays stable.
  const iInt = hosts[best.i].intensityLevel ?? 0;
  const jInt = hosts[best.j].intensityLevel ?? 0;
  const [aIndex, bIndex] =
    iInt >= jInt ? [best.i, best.j] : [best.j, best.i];

  return {
    aIndex,
    bIndex,
    pair: { a: best.a, b: best.b, opposition: best.opposition, leanSpread: best.leanSpread, clash: best.clash, pairScore: best.pairScore },
    ranked: ranked.map(({ i: _i, j: _j, ...rest }) => rest),
  };
}

/** Do this episode's stored/generated speaker names/ids match the given cast?
 *  Used by validators to accept whatever two hosts the episode was cast with,
 *  never a hardcoded pair. */
export function makeSpeakerMatchers<T extends CastHost>({ hostA, hostB }: { hostA: T; hostB: T }) {
  const byLowerName = new Map<string, T>([
    [hostA.name.toLowerCase(), hostA],
    [hostB.name.toLowerCase(), hostB],
  ]);
  return {
    /** The cast host whose chair this speakerName occupies, or null. */
    hostForSpeaker(speakerName: unknown): T | null {
      if (typeof speakerName !== "string") return null;
      return byLowerName.get(speakerName.trim().toLowerCase()) ?? null;
    },
    isValidSpeaker(speakerName: unknown): boolean {
      return this.hostForSpeaker(speakerName) !== null;
    },
    /** hostId that should be attached to a line spoken by speakerName. */
    expectedHostId(speakerName: unknown): string | null {
      return this.hostForSpeaker(speakerName)?.id ?? null;
    },
    hostNames: [hostA.name, hostB.name] as const,
  };
}
