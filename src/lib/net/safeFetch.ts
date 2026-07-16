// The ONE outbound fetcher for operator/remote-supplied URLs.
//
// Everything that makes this safe hinges on a single idea: THE ADDRESS WE
// VALIDATE MUST BE THE ADDRESS WE CONNECT TO.
//
// Validating a hostname and then handing the URL to a generic HTTP client is
// not a defence — the client resolves DNS again, and an attacker who controls
// the authoritative answer simply returns a public IP for our check and
// 169.254.169.254 for the client's (DNS rebinding / TOCTOU). So here we:
//
//   1. resolve the hostname ONCE ourselves,
//   2. reject the request if ANY returned address is non-public,
//   3. pin the socket to a validated address via `lookup`, which node's http
//      stack calls instead of resolving — so no second DNS answer can ever be
//      used, and
//   4. keep the original hostname for TLS SNI + the Host header, so
//      certificate validation still applies to the real name.
//
// Redirects are followed MANUALLY: each hop re-enters the same pipeline from
// step 0 (parse → hostname policy → resolve → validate → pin). An automatic
// redirect follower would defeat every check above on hop 2.
//
// This project has no undici/axios/got and no ipaddr.js, so this is built on
// node:https / node:dns / node:zlib. Node 20 (see Dockerfile) supports the
// `lookup` option used for pinning.

import https from "node:https";
import http from "node:http";
import dnsPromises from "node:dns/promises";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { validateUrl, isBlockedAddress, isBlockedHostname, canonicalizeUrl } from "./urlSafety";
import { e2eStubFetch } from "./e2eFetchStub";
import { FETCH_LIMITS, ALLOWED_CONTENT_TYPES } from "./fetchLimits";

// The limits live in a dependency-free module so client code can quote the same
// numbers without importing node:https/node:dns through this file.
export { FETCH_LIMITS, ALLOWED_CONTENT_TYPES } from "./fetchLimits";

/** A neutral UA. Carries no secret, no token, no personal data. */
const USER_AGENT = "TakeMachineBot/1.0 (+editorial research; contact: operator)";

export type FetchErrorCategory =
  | "invalid_url"
  | "unsupported_protocol"
  | "embedded_credentials"
  | "url_too_long"
  | "blocked_destination"
  | "dns_resolution_failed"
  | "redirect_blocked"
  | "too_many_redirects"
  | "timeout"
  | "response_too_large"
  | "unsupported_content_type"
  | "tls_error"
  | "fetch_failed";

export interface SafeFetchOk {
  ok: true;
  /** The final URL after every validated redirect, canonicalized. */
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  /** Addresses actually connected to, in hop order. Proof of pinning, for tests + audit. */
  connectedAddresses: string[];
  redirectCount: number;
}

export interface SafeFetchErr {
  ok: false;
  category: FetchErrorCategory;
  /** SAFE for the browser: no IPs, no stack traces, no internal topology. */
  message: string;
  /** Operator detail for the server log only. Never returned to a client. */
  internal?: string;
}

export type SafeFetchResult = SafeFetchOk | SafeFetchErr;

/** Injectable seams so tests can drive DNS + transport deterministically,
 *  WITHOUT ever touching the real internet. */
export interface SafeFetchDeps {
  /** Resolve a hostname to every address DNS would return. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Perform one already-validated, already-pinned request. */
  request?: typeof https.request;
  /** Same for cleartext http. */
  httpRequest?: typeof http.request;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const records = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

function safeMessage(category: FetchErrorCategory): string {
  switch (category) {
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

function fail(category: FetchErrorCategory, internal?: string): SafeFetchErr {
  // The category + a generic sentence go to the browser. The detail — which may
  // name an address or carry a driver message — stays server-side.
  if (internal) console.warn(`[safeFetch] ${category}: ${internal}`);
  return { ok: false, category, message: safeMessage(category), internal };
}

/** Resolve + validate a hostname, returning ONE address we may pin to. */
async function resolveAndValidate(
  hostname: string,
  deps: SafeFetchDeps
): Promise<{ ok: true; address: string; family: 4 | 6 } | SafeFetchErr> {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

  // A literal IP in the URL needs no DNS — validate it directly.
  const literal = /^[0-9.]+$/.test(bare) || bare.includes(":");
  if (literal) {
    if (isBlockedAddress(bare)) return fail("blocked_destination", `literal address refused: ${bare}`);
    return { ok: true, address: bare, family: bare.includes(":") ? 6 : 4 };
  }

  let addresses: string[];
  try {
    addresses = await (deps.resolve ?? defaultResolve)(hostname);
  } catch (err) {
    return fail("dns_resolution_failed", `${hostname}: ${(err as Error).message}`);
  }
  if (!addresses || addresses.length === 0) {
    return fail("dns_resolution_failed", `${hostname}: no addresses returned`);
  }

  // STRICT: if ANY answer is non-public we refuse the whole request rather than
  // cherry-picking a public one. A host that answers with a mix is either
  // misconfigured or attacking us; either way we don't want its content.
  const blocked = addresses.filter((a) => isBlockedAddress(a));
  if (blocked.length > 0) {
    return fail("blocked_destination", `${hostname} resolved to non-public address(es): ${blocked.join(", ")}`);
  }

  const address = addresses[0];
  return { ok: true, address, family: address.includes(":") ? 6 : 4 };
}

/** One request to an ALREADY validated + pinned destination. No redirects here. */
function requestOnce(
  url: URL,
  pinned: { address: string; family: 4 | 6 },
  deps: SafeFetchDeps
): Promise<{ status: number; headers: http.IncomingHttpHeaders; stream: Readable; remoteAddress: string } | SafeFetchErr> {
  return new Promise((resolve) => {
    const isHttps = url.protocol === "https:";
    const requestFn = isHttps ? deps.request ?? https.request : deps.httpRequest ?? http.request;

    let settled = false;
    const done = (v: Awaited<ReturnType<typeof requestOnce>>) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const req = requestFn(
      {
        protocol: url.protocol,
        // `host`/`hostname` stay the REAL name so the Host header and TLS SNI
        // are correct; `lookup` below decides the actual address.
        hostname: url.hostname,
        port: url.port ? Number(url.port) : isHttps ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        // TLS is verified against the real hostname. Never disabled.
        servername: isHttps ? url.hostname : undefined,
        rejectUnauthorized: true,
        // No cookies. No Authorization. No API keys. Nothing of ours leaves.
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
          // Explicitly close: no pooled/reused socket can outlive validation.
          Connection: "close",
        },
        timeout: FETCH_LIMITS.connectTimeoutMs,
        // THE PIN. node calls this instead of resolving, so the socket can only
        // ever go to the address we already validated. A rebound DNS answer is
        // never consulted, because DNS is never consulted again.
        lookup: (_hostname: string, _opts: unknown, cb: (err: Error | null, addr: string, fam: number) => void) => {
          cb(null, pinned.address, pinned.family);
        },
      } as https.RequestOptions,
      (res) => {
        done({
          status: res.statusCode ?? 0,
          headers: res.headers,
          stream: res as unknown as Readable,
          remoteAddress: res.socket?.remoteAddress ?? pinned.address,
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      done(fail("timeout", `${url.hostname}: connect/idle timeout`));
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      const msg = err?.message || "";
      const tls =
        typeof err?.code === "string" &&
        (err.code.startsWith("ERR_TLS") ||
          err.code === "CERT_HAS_EXPIRED" ||
          err.code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
          err.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
          err.code === "SELF_SIGNED_CERT_IN_CHAIN");
      done(tls ? fail("tls_error", `${url.hostname}: ${msg}`) : fail("fetch_failed", `${url.hostname}: ${msg}`));
    });

    req.end();
  });
}

/** Read a body with BOTH a wire cap and a decompressed cap, aborting on either. */
async function readBounded(
  stream: Readable,
  encoding: string | undefined
): Promise<{ ok: true; text: string } | SafeFetchErr> {
  return new Promise((resolve) => {
    let compressed = 0;
    let decompressed = 0;
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (v: { ok: true; text: string } | SafeFetchErr) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      resolve(v);
    };

    let sink: Readable = stream;
    let decoder: zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null = null;
    const enc = (encoding || "").toLowerCase();
    if (enc.includes("gzip")) decoder = zlib.createGunzip();
    else if (enc.includes("br")) decoder = zlib.createBrotliDecompress();
    else if (enc.includes("deflate")) decoder = zlib.createInflate();

    // Count bytes ON THE WIRE before any decompression — a zip bomb must be
    // stopped by the compressed cap too, not only after it expands.
    stream.on("data", (c: Buffer) => {
      compressed += c.length;
      if (compressed > FETCH_LIMITS.maxCompressedBytes) {
        finish(fail("response_too_large", `compressed body exceeded ${FETCH_LIMITS.maxCompressedBytes} bytes`));
      }
    });

    if (decoder) {
      stream.pipe(decoder);
      decoder.on("error", () => finish(fail("fetch_failed", "invalid compressed response")));
      sink = decoder as unknown as Readable;
    }

    sink.on("data", (c: Buffer) => {
      decompressed += c.length;
      if (decompressed > FETCH_LIMITS.maxDecompressedBytes) {
        finish(fail("response_too_large", `decompressed body exceeded ${FETCH_LIMITS.maxDecompressedBytes} bytes`));
        return;
      }
      chunks.push(c);
    });
    sink.on("end", () => finish({ ok: true, text: Buffer.concat(chunks).toString("utf8") }));
    sink.on("error", (err: Error) => finish(fail("fetch_failed", `stream error: ${err.message}`)));
    stream.on("aborted", () => finish(fail("fetch_failed", "the connection was aborted before the response completed")));
  });
}

function contentTypeAllowed(raw: string | undefined): boolean {
  const mime = (raw || "").split(";")[0].trim().toLowerCase();
  return (ALLOWED_CONTENT_TYPES as readonly string[]).includes(mime);
}

/**
 * Fetch a URL safely, following at most FETCH_LIMITS.maxRedirects validated
 * hops. NEVER throws — always returns a structured result.
 */
export async function safeFetch(rawUrl: string, deps: SafeFetchDeps = {}): Promise<SafeFetchResult> {
  // E2E ONLY: the harness must never make a real outbound request. Inert in
  // production (shouldStubOutboundFetch re-checks E2E_TEST_MODE), and it runs
  // AFTER nothing — the stub itself re-applies the structural URL rules, and
  // returns null for anything it hasn't staged so no request escapes silently.
  const stubbed = e2eStubFetch(rawUrl);
  if (stubbed) return stubbed;

  const startedAt = Date.now();
  const connectedAddresses: string[] = [];
  let current = rawUrl;
  let redirectCount = 0;

  for (;;) {
    if (Date.now() - startedAt > FETCH_LIMITS.totalTimeoutMs) {
      return fail("timeout", "total request budget exhausted");
    }

    // STEP 0 — every hop is validated from scratch, including redirects.
    const parsed = validateUrl(current);
    if (!parsed.ok || !parsed.url) {
      const category: FetchErrorCategory =
        parsed.reason === "blocked_hostname" ? "blocked_destination" : (parsed.reason as FetchErrorCategory) ?? "invalid_url";
      // A redirect INTO a bad place is reported as a redirect problem, so the
      // operator can tell "your link is wrong" from "your link is a trap".
      return redirectCount > 0
        ? fail("redirect_blocked", `redirect ${redirectCount} rejected: ${parsed.detail}`)
        : fail(category, parsed.detail);
    }

    const pinned = await resolveAndValidate(parsed.url.hostname, deps);
    if ("ok" in pinned && pinned.ok === false) {
      return redirectCount > 0 ? fail("redirect_blocked", pinned.internal) : pinned;
    }
    const target = pinned as { ok: true; address: string; family: 4 | 6 };

    const res = await requestOnce(parsed.url, target, deps);
    if ("ok" in res && res.ok === false) return res;
    const response = res as { status: number; headers: http.IncomingHttpHeaders; stream: Readable; remoteAddress: string };
    connectedAddresses.push(response.remoteAddress || target.address);

    // Belt AND braces: whatever the socket says it connected to must also be
    // public. If a custom lookup were ever bypassed, this still refuses.
    if (isBlockedAddress(response.remoteAddress || target.address)) {
      response.stream.destroy();
      return fail("blocked_destination", `socket landed on a non-public address: ${response.remoteAddress}`);
    }

    // ---- Redirects: manual, revalidated, capped ----
    if (response.status >= 300 && response.status < 400) {
      response.stream.resume(); // discard the body; we only want Location
      const location = response.headers.location;
      if (!location) return fail("fetch_failed", `status ${response.status} without a Location header`);
      if (redirectCount >= FETCH_LIMITS.maxRedirects) {
        return fail("too_many_redirects", `exceeded ${FETCH_LIMITS.maxRedirects} redirects`);
      }
      let next: string;
      try {
        next = new URL(location, parsed.url).toString();
      } catch {
        return fail("redirect_blocked", `unparseable Location: ${location}`);
      }
      redirectCount++;
      current = next; // loop → full revalidation of the new hop
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      response.stream.destroy();
      return fail("fetch_failed", `HTTP ${response.status}`);
    }

    const contentType = String(response.headers["content-type"] || "");
    if (!contentTypeAllowed(contentType)) {
      response.stream.destroy();
      return fail("unsupported_content_type", `content-type: ${contentType || "(none)"}`);
    }

    // Trust the declared length when it already exceeds the cap — no point
    // streaming megabytes to discover what the header told us.
    const declared = Number(response.headers["content-length"] || 0);
    if (declared && declared > FETCH_LIMITS.maxCompressedBytes) {
      response.stream.destroy();
      return fail("response_too_large", `content-length ${declared}`);
    }

    const body = await readBounded(response.stream, response.headers["content-encoding"] as string | undefined);
    if ("ok" in body && body.ok === false) return body;

    return {
      ok: true,
      finalUrl: canonicalizeUrl(parsed.url),
      status: response.status,
      contentType,
      body: (body as { ok: true; text: string }).text,
      connectedAddresses,
      redirectCount,
    };
  }
}

/** Convenience for the "is this destination allowed at all" question. */
export { validateUrl, isBlockedAddress, isBlockedHostname, canonicalizeUrl };
