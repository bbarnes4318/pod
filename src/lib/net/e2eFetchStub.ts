// Deterministic stand-in for the public internet, used ONLY by the Playwright
// harness (E2E_TEST_MODE=1). Inert in production — every entry point re-checks
// the flag, exactly like the existing e2eSeam.
//
// Why a stub at all: the E2E harness must never make a real outbound request.
// The rules that matter (scheme, credentials, destination classification,
// redirect policy) are still evaluated for real BEFORE this is consulted, so
// the admin surface is genuinely exercising them; only the socket is faked.
// The connection-level guarantees — pinning, DNS rebinding, redirect
// revalidation, size/time limits — are proven against the real transport in
// test:url-security.

import { shouldStubOutboundFetch } from "../e2eSeam";
import type { SafeFetchResult } from "./safeFetch";
import { validateUrl, canonicalizeUrl, isBlockedHostname } from "./urlSafety";

const ARTICLE = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title>` +
  `<meta property="og:site_name" content="E2E Wire"><meta name="author" content="Pat Reporter">` +
  `<meta property="article:published_time" content="2026-07-10T12:00:00Z"></head>` +
  `<body><p>${body}</p></body></html>`;

const LONG = "Real reporting text that comfortably exceeds the minimum length for an excerpt. ".repeat(3);

/**
 * Fixed routes the admin E2E spec drives. Hostnames are `.test`, which is
 * reserved by RFC 6761 and can never resolve to a real server.
 */
export function e2eStubFetch(rawUrl: string): SafeFetchResult | null {
  if (!shouldStubOutboundFetch()) return null;

  // Structural rules run for real first — a bad URL fails the same way it would
  // in production, and the stub never rescues it.
  const parsed = validateUrl(rawUrl);
  if (!parsed.ok || !parsed.url) return null;

  const host = parsed.url.hostname.toLowerCase();
  // Anything not explicitly staged is treated as unreachable, so a stray URL in
  // a test can never silently reach the network.
  if (!host.endsWith(".test")) return null;
  if (isBlockedHostname(host)) return null;

  const url = canonicalizeUrl(parsed.url);
  const ok = (body: string, contentType = "text/html"): SafeFetchResult => ({
    ok: true, finalUrl: url, status: 200, contentType, body,
    connectedAddresses: ["93.184.216.34"], redirectCount: 0,
  });

  switch (host) {
    case "wire.test":
      return ok(ARTICLE("Chiefs stun Eagles in overtime thriller", LONG));
    case "wire2.test":
      return ok(ARTICLE("Second wire report: the MVP case", LONG));
    case "hostile.test":
      // Proves sanitization end-to-end: none of this may reach the browser.
      return ok(
        `<!doctype html><html><head><title>Hostile &amp; Tricky</title>` +
        `<meta name="author" content="Eve <script>alert('xss')</script> Adversary">` +
        `<script>window.__pwned = 1; var s = "PWNEDPAYLOAD";</script></head>` +
        `<body><iframe src="http://169.254.169.254/latest/meta-data/"></iframe>` +
        `<p onclick="alert('handler')">${LONG}</p></body></html>`
      );
    case "slow.test":
      return { ok: false, category: "timeout", message: "That site took too long to respond." };
    case "huge.test":
      return { ok: false, category: "response_too_large", message: "That page is too large to import." };
    case "binary.test":
      return { ok: false, category: "unsupported_content_type", message: "That link isn't an article page." };
    case "redirect-internal.test":
      // A public page that redirects to an internal address: safeFetch would
      // refuse at the second hop, and the stub reports the same category.
      return { ok: false, category: "redirect_blocked", message: "That link redirects somewhere this server won't fetch." };
    case "gone.test":
      return { ok: false, category: "fetch_failed", message: "That link couldn't be fetched." };
    default:
      return null;
  }
}
