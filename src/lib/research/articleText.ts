// Zero-cost enrichment: fetch the full text behind news URLs we already
// ingested (RSS gives us 250-char summaries — headline-level by design).
// Extracting facts/numbers/quotes from the article body gives the research
// brief real depth without any new paid API.
//
// Licensing note: this text is used internally as research material only.
// Brief/script prompts require paraphrasing and cap quotes at ~20 words with
// attribution — we never reproduce article passages into published scripts.

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
 */
export async function fetchArticleExcerpts(
  urls: string[],
  opts: { maxArticles?: number; maxCharsPerArticle?: number; timeoutMs?: number } = {}
): Promise<ArticleExcerpt[]> {
  const maxArticles = opts.maxArticles ?? 4;
  const maxChars = opts.maxCharsPerArticle ?? 2200;
  const timeoutMs = opts.timeoutMs ?? 8000;

  const targets = urls.filter((u) => /^https?:\/\//i.test(u)).slice(0, maxArticles);

  const results = await Promise.all(
    targets.map(async (url): Promise<ArticleExcerpt> => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(url, {
          signal: controller.signal,
          headers: {
            "User-Agent": "TakeMachineResearch/1.0 (podcast research; contact: owner)",
            Accept: "text/html,application/xhtml+xml",
          },
          redirect: "follow",
        });
        clearTimeout(timer);
        if (!res.ok || !(res.headers.get("content-type") || "").includes("html")) {
          return { url, excerpt: "", ok: false };
        }
        const html = await res.text();
        const excerpt = extractReadableText(html.slice(0, 500_000), maxChars);
        return { url, excerpt, ok: excerpt.length > 100 };
      } catch {
        return { url, excerpt: "", ok: false };
      }
    })
  );

  return results;
}
