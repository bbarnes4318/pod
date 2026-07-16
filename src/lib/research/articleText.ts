// Zero-cost enrichment: fetch the full text behind news URLs we already
// ingested (RSS gives us 250-char summaries — headline-level by design).
// Extracting facts/numbers/quotes from the article body gives the research
// brief real depth without any new paid API.
//
// Licensing note: this text is used internally as research material only.
// Brief/script prompts require paraphrasing and cap quotes at ~20 words with
// attribution — we never reproduce article passages into published scripts.

import { safeFetch } from "../net/safeFetch";

const BLOCK_TAGS = /<(script|style|noscript|svg|iframe|form|nav|footer|header|aside)[\s\S]*?<\/\1>/gi;

function extractReadableText(html: string, maxChars: number): string {
  // Prefer paragraph content — that's where the reporting lives.
  const withoutBlocks = html.replace(BLOCK_TAGS, " ");
  const paragraphs = [...withoutBlocks.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) =>
      m[1]
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;|&#160;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&quot;|&#34;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter((p) => p.length > 60 && !/cookie|subscribe|newsletter|sign up|advertis/i.test(p));

  let out = "";
  for (const p of paragraphs) {
    if (out.length + p.length > maxChars) break;
    out += (out ? "\n" : "") + p;
  }
  return out;
}

export interface ArticleExcerpt {
  url: string;
  excerpt: string;
  ok: boolean;
}

/**
 * Fetch readable excerpts for up to `maxArticles` URLs, tolerant of any
 * failure (timeouts, paywalls, non-HTML). Never throws.
 *
 * SECURITY: these URLs come out of third-party RSS feeds, so they are NOT
 * trusted input — a compromised or hostile feed could point us at
 * http://169.254.169.254/ or http://127.0.0.1:6379. This now goes through the
 * shared safeFetch, which is the single hardened outbound path: destination
 * validation, a socket pinned to a validated public address (so DNS rebinding
 * can't move it), manual per-hop redirect revalidation, and streamed size
 * caps. Previously this used `fetch(url, { redirect: "follow" })` with no
 * destination checks and buffered the whole body before truncating it.
 *
 * `timeoutMs` is gone: timeouts are centralized in FETCH_LIMITS so every
 * caller gets the same audited budget.
 */
export async function fetchArticleExcerpts(
  urls: string[],
  opts: { maxArticles?: number; maxCharsPerArticle?: number } = {}
): Promise<ArticleExcerpt[]> {
  const maxArticles = opts.maxArticles ?? 4;
  const maxChars = opts.maxCharsPerArticle ?? 2200;

  // De-dupe before spending a request, and cap the fan-out.
  const targets = [...new Set(urls.filter((u) => typeof u === "string" && u.trim()))].slice(0, maxArticles);

  const results = await Promise.all(
    targets.map(async (url): Promise<ArticleExcerpt> => {
      // safeFetch never throws — it validates the destination, pins the socket
      // to a validated public address, revalidates every redirect, and bounds
      // the body. It returns a structured result either way.
      const res = await safeFetch(url);
      if (!res.ok) return { url, excerpt: "", ok: false };
      const excerpt = extractReadableText(res.body, maxChars);
      return { url, excerpt, ok: excerpt.length > 100 };
    })
  );

  return results;
}
