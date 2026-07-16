// Outbound-fetch limits, in ONE place, shared by the server that enforces them
// and the UI copy that explains them.
//
// This file is deliberately dependency-free (no node:*, no server imports) so a
// CLIENT component can state the same numbers the server enforces without
// dragging the fetcher — and its node:https/node:dns/node:zlib imports — into
// the browser bundle.

/** Centralized, documented limits. Conservative on purpose. */
export const FETCH_LIMITS = {
  /** TCP connect + TLS handshake. */
  connectTimeoutMs: 5_000,
  /** Time to first byte of the response headers. */
  headersTimeoutMs: 10_000,
  /** Whole request, headers + body. Hard ceiling on a slow drip. */
  totalTimeoutMs: 15_000,
  /** Redirect hops. Each is fully revalidated. */
  maxRedirects: 3,
  /** Bytes ON THE WIRE. Enforced while streaming — never buffered first. */
  maxCompressedBytes: 2 * 1024 * 1024,
  /** Bytes AFTER decompression. Guards a zip bomb. */
  maxDecompressedBytes: 5 * 1024 * 1024,
  /** Characters of extracted article text kept. */
  maxExtractedChars: 100_000,
  /** URLs accepted in one ingestion request. */
  maxUrlsPerRequest: 5,
  /** Simultaneous outbound fetches per ingestion request. */
  maxConcurrentFetches: 2,
} as const;

/** Response types that can plausibly BE an article. Everything else is refused. */
export const ALLOWED_CONTENT_TYPES = ["text/html", "text/plain", "application/xhtml+xml"] as const;
