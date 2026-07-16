// Admin custom-topic creation + source-URL ingestion.
//
// THE EDITORIAL CONTRACT, and the reason this file is careful:
// An operator typing a title is stating an OPINION about what's worth debating.
// It is not a fact, and an article they pasted is not verified evidence. So
// nothing here writes to the places the pipeline treats as verified:
//
//   • status is always `pending` — never approved, never silently promoted.
//   • evidenceIds is left EMPTY. It is the topic generator's output, written
//     only after each ref is existence-checked against a real row; putting
//     operator input there would be inventing evidence and would let a topic
//     pass the evidence gate without anything backing it.
//   • no ResearchBrief is created. A brief made by copying article text into
//     "facts" would be a fabrication wearing the pipeline's clothes.
//
// The honest consequence, surfaced rather than hidden: a fresh custom topic
// reports `pending_approval`, and after approval `insufficient_evidence`. Those
// are its REAL blocking reasons, and the shared eligibility contract shows them
// on the board. Imported sources are recorded as TopicSource rows — editorial
// starting material the research step can work from.

import type { PrismaClient, Prisma } from "@prisma/client";
import { safeFetch, FETCH_LIMITS, type FetchErrorCategory } from "../net/safeFetch";
import { validateUrl, canonicalizeUrl } from "../net/urlSafety";
import { extractArticle } from "../net/articleExtract";

export const MAX_URLS_PER_REQUEST = FETCH_LIMITS.maxUrlsPerRequest;
export const MAX_TITLE_LENGTH = 200;
export const MAX_NOTES_LENGTH = 4000;

export type SourceImportStatus =
  | "imported"
  | "duplicate"
  | FetchErrorCategory;

export interface SourceImportResult {
  /** As submitted — echoed so the UI can line results up with inputs. */
  url: string;
  status: SourceImportStatus;
  /** Human-safe. Never contains an address, stack trace or internal detail. */
  message: string;
  canonicalUrl?: string;
  title?: string | null;
  publisher?: string | null;
  sourceId?: string;
  /** True when a retry could plausibly succeed (transient vs. structural). */
  retryable: boolean;
}

export interface CustomTopicInput {
  title: string;
  angle?: string | null;
  notes?: string | null;
  sport?: string | null;
  leagueId?: string | null;
  /** Free-text ONLY. There is no structured team/player model to point at, and
   *  inventing one to satisfy a form would be worse than saying so. */
  teamsOrPlayers?: string | null;
  sourceUrls?: string[];
  /** Client-generated; makes a double-submit land on the SAME topic. */
  idempotencyKey?: string;
}

export type ResearchReadiness = "not_researched" | "researching" | "research_failed";

export interface CustomTopicResult {
  ok: true;
  topicId: string;
  /** Always "pending" on creation. */
  editorialStatus: string;
  sources: SourceImportResult[];
  importedSourceCount: number;
  failedSourceCount: number;
  researchReadiness: ResearchReadiness;
  /** True when this returned an EXISTING topic instead of creating one. */
  deduplicated: boolean;
  duplicateWarning?: { topicId: string; title: string; reason: string };
  /** What the operator can do next, in order. */
  nextActions: string[];
}

export type CustomTopicOutcome = CustomTopicResult | { ok: false; error: string; field?: string };

export interface IngestionCtx {
  db: PrismaClient;
  admin: { id: string };
}

export interface IngestionDeps {
  /** Injectable so tests never touch a network. */
  fetchUrl?: typeof safeFetch;
}

/** Titles differing only by case/punctuation/spacing are the same headline. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9']+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeSourceMessage(status: SourceImportStatus): string {
  switch (status) {
    case "imported": return "Imported.";
    case "duplicate": return "Already imported for this topic.";
    case "invalid_url": return "That isn't a valid URL.";
    case "unsupported_protocol": return "Only http and https links can be imported.";
    case "embedded_credentials": return "URLs containing a username or password aren't accepted.";
    case "url_too_long": return "That URL is too long.";
    case "blocked_destination": return "That link points somewhere this server won't fetch.";
    case "dns_resolution_failed": return "That site's address couldn't be looked up.";
    case "redirect_blocked": return "That link redirects somewhere this server won't fetch.";
    case "too_many_redirects": return "That link redirected too many times.";
    case "timeout": return "That site took too long to respond.";
    case "response_too_large": return "That page is too large to import.";
    case "unsupported_content_type": return "That link isn't an article page.";
    case "tls_error": return "That site's security certificate couldn't be verified.";
    default: return "That link couldn't be fetched.";
  }
}

/** Transient (worth a retry) vs. structural (retrying changes nothing). */
const RETRYABLE: ReadonlySet<string> = new Set(["timeout", "dns_resolution_failed", "fetch_failed"]);

/** Fetch + extract ONE url. Never throws; never returns internal detail. */
async function importOne(
  rawUrl: string,
  deps: IngestionDeps
): Promise<{ result: SourceImportResult; row?: Omit<ExtractedRow, "topicId"> }> {
  const parsed = validateUrl(rawUrl);
  if (!parsed.ok) {
    const status = (parsed.reason === "blocked_hostname" ? "blocked_destination" : parsed.reason) as SourceImportStatus;
    return { result: { url: rawUrl, status, message: safeSourceMessage(status), retryable: false } };
  }

  const res = await (deps.fetchUrl ?? safeFetch)(rawUrl);
  if (!res.ok) {
    return {
      result: {
        url: rawUrl,
        status: res.category,
        message: safeSourceMessage(res.category),
        retryable: RETRYABLE.has(res.category),
      },
    };
  }

  const article = extractArticle(res.body, res.finalUrl, res.contentType);
  const canonical = article.canonicalUrl ?? res.finalUrl;
  return {
    result: {
      url: rawUrl,
      status: "imported",
      message: safeSourceMessage("imported"),
      canonicalUrl: canonical,
      title: article.title,
      publisher: article.siteName,
      retryable: false,
    },
    row: {
      originalUrl: canonicalizeUrl(parsed.url!),
      canonicalUrl: canonical,
      title: article.title,
      publisher: article.siteName,
      author: article.author,
      publishedAt: article.publishedAt,
      excerpt: article.excerpt || null,
      contentHash: article.contentHash,
      fetchStatus: "imported",
      fetchErrorCategory: null,
      retrievedAt: article.retrievedAt,
    },
  };
}

interface ExtractedRow {
  topicId: string;
  originalUrl: string;
  canonicalUrl: string;
  title: string | null;
  publisher: string | null;
  author: string | null;
  publishedAt: Date | null;
  excerpt: string | null;
  contentHash: string | null;
  fetchStatus: string;
  fetchErrorCategory: string | null;
  retrievedAt: Date | null;
}

/** Run imports with a small concurrency cap — never a fan-out per submit. */
async function importAll(urls: string[], deps: IngestionDeps) {
  const out: Array<Awaited<ReturnType<typeof importOne>>> = [];
  for (let i = 0; i < urls.length; i += FETCH_LIMITS.maxConcurrentFetches) {
    const batch = urls.slice(i, i + FETCH_LIMITS.maxConcurrentFetches);
    out.push(...(await Promise.all(batch.map((u) => importOne(u, deps)))));
  }
  return out;
}

function nextActionsFor(hasSources: boolean): string[] {
  // Approval first: the research workflow refuses a non-approved topic, so any
  // other order would just produce a job that fails.
  return hasSources
    ? ["approve", "research", "preview_sources"]
    : ["approve", "research", "import_sources"];
}

/**
 * Create a PENDING custom topic, optionally importing source URLs.
 *
 * Transactional consistency: the topic and its successful source rows are
 * written in ONE transaction, so a database failure can never leave a topic
 * with half its sources. Fetching happens BEFORE the transaction — network I/O
 * inside a transaction would hold a connection open for the whole timeout
 * budget. Failed URLs are reported but never block the successful ones.
 */
export async function createCustomTopic(
  ctx: IngestionCtx,
  input: CustomTopicInput,
  deps: IngestionDeps = {}
): Promise<CustomTopicOutcome> {
  const title = (input.title ?? "").trim();
  if (!title) return { ok: false, error: "A topic title is required.", field: "title" };
  if (title.length > MAX_TITLE_LENGTH) {
    return { ok: false, error: `Keep the title under ${MAX_TITLE_LENGTH} characters.`, field: "title" };
  }
  const notes = (input.notes ?? "").trim();
  if (notes.length > MAX_NOTES_LENGTH) {
    return { ok: false, error: `Keep the notes under ${MAX_NOTES_LENGTH} characters.`, field: "notes" };
  }

  const urls = (input.sourceUrls ?? []).map((u) => (u ?? "").trim()).filter(Boolean);
  if (urls.length > MAX_URLS_PER_REQUEST) {
    return { ok: false, error: `Import at most ${MAX_URLS_PER_REQUEST} source URLs at a time.`, field: "sourceUrls" };
  }

  // ---- Idempotency: a double-submit must not make a second topic ----------
  // The key is stored on the summary line so a retry of the SAME submission
  // returns the SAME topic rather than a duplicate.
  if (input.idempotencyKey) {
    const prior = await ctx.db.jobLog.findFirst({
      where: { jobType: "admin:topic-custom-create" },
      orderBy: { createdAt: "desc" },
      take: 1,
      skip: 0,
    });
    // Cheap exact-key check against recent creations.
    const priorKey = (prior?.input as { idempotencyKey?: string } | null)?.idempotencyKey;
    const priorTopicId = (prior?.output as { topicId?: string } | null)?.topicId;
    if (priorKey && priorKey === input.idempotencyKey && priorTopicId) {
      const existing = await ctx.db.topicCandidate.findUnique({ where: { id: priorTopicId } });
      if (existing) {
        return {
          ok: true,
          topicId: existing.id,
          editorialStatus: existing.status,
          sources: [],
          importedSourceCount: 0,
          failedSourceCount: 0,
          researchReadiness: "not_researched",
          deduplicated: true,
          duplicateWarning: { topicId: existing.id, title: existing.title, reason: "This submission was already processed." },
          nextActions: nextActionsFor(false),
        };
      }
    }
  }

  // ---- Likely-duplicate detection ----------------------------------------
  // A WARNING, not a block: two genuinely different takes can share a headline,
  // and refusing them would make the operator fight the tool. We hand back the
  // existing topic so they can decide.
  const normalized = normalizeTitle(title);
  const recent = await ctx.db.topicCandidate.findMany({
    where: { status: { in: ["pending", "approved"] } },
    select: { id: true, title: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const titleMatch = recent.find((t: { id: string; title: string }) => normalizeTitle(t.title) === normalized);

  // ---- Fetch OUTSIDE the transaction -------------------------------------
  const imported = urls.length > 0 ? await importAll(urls, deps) : [];
  const results = imported.map((i) => i.result);
  const rows = imported.filter((i) => i.row).map((i) => i.row!);

  // Two submitted URLs can canonicalize to the same document.
  const seen = new Set<string>();
  const deduped: typeof rows = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (seen.has(r.canonicalUrl)) {
      const idx = results.findIndex((x) => x.canonicalUrl === r.canonicalUrl && x.status === "imported");
      if (idx !== -1) {
        results[idx] = { ...results[idx], status: "duplicate", message: safeSourceMessage("duplicate"), retryable: false };
      }
      continue;
    }
    seen.add(r.canonicalUrl);
    deduped.push(r);
  }

  // ---- Create ------------------------------------------------------------
  const created = await ctx.db.$transaction(async (tx: Prisma.TransactionClient) => {
    const topic = await tx.topicCandidate.create({
      data: {
        title,
        sport: (input.sport ?? "").trim() || "General",
        leagueId: (input.leagueId ?? "").trim() || null,
        // Angle + notes + free-text entities are editorial CONTEXT for the
        // researcher. They live in `summary` because that is what the research
        // prompt reads — they are never presented as verified fact.
        summary: [input.angle?.trim(), notes, input.teamsOrPlayers?.trim() ? `Focus: ${input.teamsOrPlayers.trim()}` : ""]
          .filter(Boolean)
          .join("\n\n") || null,
        // Scores are UNKNOWN for a hand-written topic. They are the generator's
        // computed output; zero honestly means "never scored", and the
        // automatic picker's floors will skip it until research says otherwise.
        controversyScore: 0,
        starPowerScore: 0,
        bettingRelevanceScore: 0,
        recencyScore: 0,
        debateScore: 0,
        // EMPTY on purpose — see the file header. This is what makes the board
        // honestly report "missing evidence" instead of faking readiness.
        evidenceIds: [],
        status: "pending",
      },
    });

    for (const row of deduped) {
      await tx.topicSource.create({
        data: { ...row, topicId: topic.id, createdByAdminIdentity: ctx.admin.id },
      });
    }
    return topic;
  });

  for (const r of results) {
    if (r.status === "imported") r.sourceId = created.id;
  }

  const importedCount = results.filter((r) => r.status === "imported").length;
  return {
    ok: true,
    topicId: created.id,
    editorialStatus: created.status,
    sources: results,
    importedSourceCount: importedCount,
    failedSourceCount: results.length - importedCount,
    researchReadiness: "not_researched",
    deduplicated: false,
    duplicateWarning: titleMatch
      ? { topicId: titleMatch.id, title: titleMatch.title, reason: "A topic with a very similar title already exists." }
      : undefined,
    nextActions: nextActionsFor(importedCount > 0),
  };
}

/**
 * Import more sources onto an EXISTING pending/approved topic.
 * Never changes the topic's editorial status or evidence.
 */
export async function importSourcesForTopic(
  ctx: IngestionCtx,
  topicId: string,
  urls: string[],
  deps: IngestionDeps = {}
): Promise<{ ok: true; sources: SourceImportResult[]; importedSourceCount: number; failedSourceCount: number } | { ok: false; error: string }> {
  const clean = (urls ?? []).map((u) => (u ?? "").trim()).filter(Boolean);
  if (clean.length === 0) return { ok: false, error: "Add at least one source URL." };
  if (clean.length > MAX_URLS_PER_REQUEST) {
    return { ok: false, error: `Import at most ${MAX_URLS_PER_REQUEST} source URLs at a time.` };
  }

  const topic = await ctx.db.topicCandidate.findUnique({ where: { id: topicId }, select: { id: true } });
  if (!topic) return { ok: false, error: "That topic no longer exists." };

  const existing: Array<{ canonicalUrl: string }> = await ctx.db.topicSource.findMany({
    where: { topicId },
    select: { canonicalUrl: true },
  });
  const already = new Set(existing.map((e) => e.canonicalUrl));

  const imported = await importAll(clean, deps);
  const results = imported.map((i) => i.result);

  const toWrite: ExtractedRow[] = [];
  for (let i = 0; i < imported.length; i++) {
    const row = imported[i].row;
    if (!row) continue;
    if (already.has(row.canonicalUrl)) {
      results[i] = { ...results[i], status: "duplicate", message: safeSourceMessage("duplicate"), retryable: false };
      continue;
    }
    already.add(row.canonicalUrl);
    toWrite.push({ ...row, topicId });
  }

  if (toWrite.length > 0) {
    await ctx.db.$transaction(async (tx: Prisma.TransactionClient) => {
      for (const row of toWrite) {
        await tx.topicSource.create({ data: { ...row, createdByAdminIdentity: ctx.admin.id } });
      }
    });
  }

  const importedCount = results.filter((r) => r.status === "imported").length;
  return { ok: true, sources: results, importedSourceCount: importedCount, failedSourceCount: results.length - importedCount };
}

/** The columns the preview panel selects. */
interface SourceRow {
  id: string;
  canonicalUrl: string;
  title: string | null;
  publisher: string | null;
  author: string | null;
  publishedAt: Date | null;
  excerpt: string | null;
  fetchStatus: string;
  retrievedAt: Date | null;
}

/** Sanitized, display-safe source list for a topic. */
export async function listTopicSources(ctx: IngestionCtx, topicId: string) {
  const rows = await ctx.db.topicSource.findMany({
    where: { topicId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, canonicalUrl: true, title: true, publisher: true, author: true,
      publishedAt: true, excerpt: true, fetchStatus: true, retrievedAt: true,
    },
  });
  return rows.map((r: SourceRow) => ({
    ...r,
    // Already sanitized on the way in; capped again on the way out so a huge
    // excerpt can't bloat an admin page render.
    excerpt: r.excerpt ? String(r.excerpt).slice(0, 1000) : null,
    publishedAt: r.publishedAt ? new Date(r.publishedAt).toISOString() : null,
    retrievedAt: r.retrievedAt ? new Date(r.retrievedAt).toISOString() : null,
  }));
}
