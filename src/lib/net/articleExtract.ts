// Turn fetched HTML into a small set of PLAIN-TEXT fields.
//
// Everything here treats the page as hostile input:
//   • No HTML is ever returned — only text. The Admin UI renders these values
//     as text nodes, so there is nothing for a browser to execute and no need
//     for dangerouslySetInnerHTML anywhere.
//   • Script/style/svg/iframe/object/embed blocks are removed before any text
//     is read, so their contents can't leak into an excerpt.
//   • Metadata (title, author, publisher) is attacker-controlled, so it is
//     length-capped and stripped of control characters and angle brackets.
//   • Regexes here are anchored and lazily quantified against a body that
//     safeFetch has ALREADY capped, so they can't be pointed at unbounded input.
//
// This project has no cheerio/jsdom, and pulling a DOM parser in to read four
// fields would add a large attack surface for no benefit — text extraction from
// a size-capped string is the smaller, more auditable choice.

import crypto from "node:crypto";
import { FETCH_LIMITS } from "./safeFetch";
import { canonicalizeUrl } from "./urlSafety";

/** Elements whose CONTENT must never reach an excerpt. */
const DANGEROUS_BLOCKS =
  /<(script|style|noscript|svg|math|iframe|object|embed|template|form|nav|footer|header|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
/** Same elements when self-closed or unterminated. */
const DANGEROUS_SELF = /<(script|style|iframe|object|embed|svg)\b[^>]*\/?>/gi;

export interface ExtractedArticle {
  title: string | null;
  siteName: string | null;
  author: string | null;
  publishedAt: Date | null;
  canonicalUrl: string | null;
  excerpt: string;
  contentHash: string;
  retrievedAt: Date;
}

/** Collapse an untrusted string into safe, bounded plain text. */
function cleanText(value: string | null | undefined, maxLen: number): string | null {
  if (!value) return null;
  const text = decodeEntities(value)
    // Remove dangerous elements WITH THEIR CONTENT first. Stripping tags alone
    // would keep the payload as text — `<script>alert(1)</script>` in a meta
    // author would survive as the literal string "alert(1)". Harmless to render
    // as a text node, but it has no business in a byline and would be a live
    // hazard the moment any consumer treated the value as markup.
    .replace(DANGEROUS_BLOCKS, " ")
    .replace(DANGEROUS_SELF, " ")
    // Strip anything tag-shaped that survived, then the brackets themselves, so
    // a stored value can never re-form an element if it is ever concatenated.
    .replace(/<[^>]*>/g, " ")
    .replace(/[<>]/g, "")
    // Control characters (incl. NUL) have no place in a title or byline.
    // eslint-disable-next-line no-control-regex -- deliberately stripping C0/C1
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > maxLen ? text.slice(0, maxLen).trim() : text;
}

/** A decoded code point, or "" for anything unsafe/unrenderable. */
function safeCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return "";
  // Control characters and surrogates are never legitimate article text.
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0xd800 && cp <= 0xdfff)) return " ";
  try { return String.fromCodePoint(cp); } catch { return ""; }
}

function decodeEntities(s: string): string {
  return (
    s
      // NUMERIC references first. Real bylines and headlines are full of them
      // (&#225; = á), and leaving them encoded corrupts ordinary metadata.
      // Doing this BEFORE &amp; means a double-encoded "&amp;#60;" decodes only
      // to the literal text "&#60;" and never sneaks back into a "<".
      // Any bracket a decode DOES produce is stripped by cleanText afterwards,
      // so decoding can't re-form an element.
      .replace(/&#x([0-9a-f]{1,6});/gi, (_m, hex: string) => safeCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d{1,7});/g, (_m, dec: string) => safeCodePoint(parseInt(dec, 10)))
      .replace(/&nbsp;/gi, " ")
      .replace(/&quot;/gi, '"')
      .replace(/&apos;|&rsquo;|&lsquo;/gi, "'")
      .replace(/&ldquo;|&rdquo;/gi, '"')
      .replace(/&mdash;/gi, "—")
      .replace(/&ndash;/gi, "–")
      .replace(/&hellip;/gi, "…")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      // &amp; LAST so "&amp;lt;" becomes the text "&lt;", not "<".
      .replace(/&amp;/gi, "&")
  );
}

function firstMatch(html: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = re.exec(html);
    if (m && m[1]) return m[1];
  }
  return null;
}

/**
 * `<meta property="og:title" content="...">` in either attribute order.
 *
 * The value is captured with a BACKREFERENCE to the opening quote, not a
 * `[^"']*` class. A class that stops at either quote truncates the value at the
 * first apostrophe — which silently mangles ordinary metadata
 * (`content="O'Brien's take"` → `O`) and, worse, can cut a hostile value
 * mid-tag so a `<script>` loses its closing tag and survives sanitization as
 * stray text. Match the quote that actually opened the attribute.
 */
function metaContent(html: string, keys: string[]): string | null {
  for (const key of keys) {
    const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`<meta[^>]+?(?:property|name|itemprop)\\s*=\\s*(["'])${k}\\1[^>]*?content\\s*=\\s*(["'])([\\s\\S]*?)\\2`, "i"),
      new RegExp(`<meta[^>]+?content\\s*=\\s*(["'])([\\s\\S]*?)\\1[^>]*?(?:property|name|itemprop)\\s*=\\s*(["'])${k}\\3`, "i"),
    ];
    // Group index differs per pattern: the value is the last captured group.
    for (let i = 0; i < patterns.length; i++) {
      const m = patterns[i].exec(html);
      if (m) {
        const value = i === 0 ? m[3] : m[2];
        if (value) return value;
      }
    }
  }
  return null;
}

function parseDate(raw: string | null): Date | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  // A publication date centuries away is a parsing artefact, not a fact.
  const year = d.getUTCFullYear();
  if (year < 1990 || year > 2100) return null;
  return d;
}

/**
 * Extract the article body as plain text, preferring <p> content (where the
 * reporting lives) and falling back to the whole stripped document.
 */
function extractBodyText(html: string, maxChars: number): string {
  const stripped = html.replace(DANGEROUS_BLOCKS, " ").replace(DANGEROUS_SELF, " ");

  const paragraphs = [...stripped.matchAll(/<p\b[^>]*>([\s\S]{0,20000}?)<\/p>/gi)]
    .map((m) => cleanText(m[1], 5_000) ?? "")
    .filter((p) => p.length > 60 && !/^(cookie|subscribe|newsletter|sign up|advertis)/i.test(p));

  let out = "";
  for (const p of paragraphs) {
    if (out.length + p.length + 1 > maxChars) break;
    out += (out ? "\n" : "") + p;
  }
  if (out) return out;

  // No usable <p> — fall back to the stripped document text so a plain-text
  // article still imports.
  return (cleanText(stripped, maxChars) ?? "").slice(0, maxChars);
}

/**
 * Extract the article fields we persist.
 *
 * `finalUrl` is the post-redirect URL safeFetch actually landed on; a page's
 * self-declared <link rel="canonical"> is only honoured when it is a valid
 * http(s) URL, and it is never used as a fetch target.
 */
export function extractArticle(html: string, finalUrl: string, contentType = "text/html"): ExtractedArticle {
  const retrievedAt = new Date();
  const contentHash = crypto.createHash("sha256").update(html).digest("hex");

  // Plain text has no metadata to mine — treat the whole payload as the body.
  if (contentType.split(";")[0].trim().toLowerCase() === "text/plain") {
    const text = (cleanText(html, FETCH_LIMITS.maxExtractedChars) ?? "").slice(0, FETCH_LIMITS.maxExtractedChars);
    return {
      title: null, siteName: null, author: null, publishedAt: null,
      canonicalUrl: finalUrl, excerpt: text, contentHash, retrievedAt,
    };
  }

  const head = html.slice(0, 200_000); // metadata lives at the top; bound the scan

  const rawTitle =
    metaContent(head, ["og:title", "twitter:title"]) ??
    firstMatch(head, [/<title[^>]*>([\s\S]{0,2000}?)<\/title>/i]) ??
    firstMatch(head, [/<h1[^>]*>([\s\S]{0,2000}?)<\/h1>/i]);

  const rawCanonical =
    firstMatch(head, [
      /<link[^>]+rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']+)["']/i,
      /<link[^>]+href\s*=\s*["']([^"']+)["'][^>]*rel\s*=\s*["']canonical["']/i,
    ]) ?? metaContent(head, ["og:url"]);

  let canonicalUrl = finalUrl;
  if (rawCanonical) {
    try {
      const resolved = new URL(decodeEntities(rawCanonical.trim()), finalUrl);
      // Only http(s), and never a credentialed URL. This value is DISPLAYED and
      // stored — it is never fetched — but it still must not be a javascript:
      // or data: URI that a link could later carry.
      if ((resolved.protocol === "http:" || resolved.protocol === "https:") && !resolved.username && !resolved.password) {
        canonicalUrl = canonicalizeUrl(resolved);
      }
    } catch { /* keep finalUrl */ }
  }

  return {
    title: cleanText(rawTitle, 300),
    siteName: cleanText(metaContent(head, ["og:site_name", "application-name"]), 120),
    author: cleanText(metaContent(head, ["author", "article:author", "og:article:author", "twitter:creator"]), 160),
    publishedAt: parseDate(
      metaContent(head, ["article:published_time", "og:article:published_time", "datePublished", "publishdate", "date"]) ??
        firstMatch(head, [/<time[^>]+datetime\s*=\s*["']([^"']+)["']/i])
    ),
    canonicalUrl,
    excerpt: extractBodyText(html, FETCH_LIMITS.maxExtractedChars),
    contentHash,
    retrievedAt,
  };
}
