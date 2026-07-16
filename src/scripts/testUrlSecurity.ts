// URL + SSRF security tests. Run: npm run test:url-security
/* eslint-disable @typescript-eslint/no-explicit-any -- test harness doubles are intentionally loose. */
//
// These tests are the reason the fetcher exists, so they are deliberately
// adversarial. Two things they take care to prove:
//
//  1. CLASSIFICATION — every blocked range, for IPv4, IPv6, and the
//     IPv4-mapped-IPv6 forms that make a v4 rule bypassable if forgotten.
//
//  2. PINNING — that the ACTUAL CONNECTION goes to the address that was
//     validated. A test that only checks a helper and then lets a real client
//     resolve independently proves nothing, so the transport is stubbed and the
//     socket's destination is asserted directly. The DNS-rebinding tests make
//     the resolver return a different (private) answer the second time it is
//     asked: if the fetcher ever re-resolved, the connection would land on the
//     rebound address and the assertion would fail.
//
// NOTHING here touches the real internet: every DNS answer and every socket is
// a local double.

import { Readable } from "node:stream";
import { isBlockedAddress, isBlockedHostname, validateUrl, canonicalizeUrl, MAX_URL_LENGTH } from "../lib/net/urlSafety";
import { safeFetch, FETCH_LIMITS, type SafeFetchDeps } from "../lib/net/safeFetch";
import { extractArticle } from "../lib/net/articleExtract";

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

/* ------------------------------------------------------------------ */
/* Transport double                                                    */
/* ------------------------------------------------------------------ */

interface StubResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Emit 'aborted' instead of finishing. */
  abort?: boolean;
  /** Never respond (drives the timeout path). */
  hang?: boolean;
}

/** Records every address the transport was actually asked to connect to. */
interface Recorder {
  connects: Array<{ address: string; hostname: string; servername?: string; port: number; path: string; headers: Record<string, string> }>;
  dnsCalls: string[];
}

function makeTransport(rec: Recorder, plan: StubResponse[] | ((hop: number) => StubResponse)) {
  let hop = 0;
  const requestFn: any = (opts: any, cb: (res: any) => void) => {
    const spec = typeof plan === "function" ? plan(hop) : plan[Math.min(hop, plan.length - 1)];
    hop++;

    const listeners: Record<string, Array<(...a: any[]) => void>> = {};
    const req: any = {
      on(ev: string, fn: (...a: any[]) => void) { (listeners[ev] ||= []).push(fn); return req; },
      destroy() { /* no-op */ },
      end() {
        // Invoke the pinned lookup EXACTLY as node's net stack would, and record
        // the address it hands back. This is what proves the pin.
        opts.lookup(opts.hostname, { all: false }, (err: Error | null, address: string) => {
          if (err) { (listeners["error"] || []).forEach((f) => f(err)); return; }
          rec.connects.push({
            address,
            hostname: opts.hostname,
            servername: opts.servername,
            port: opts.port,
            path: opts.path,
            headers: opts.headers || {},
          });

          if (spec.hang) { (listeners["timeout"] || []).forEach((f) => f()); return; }

          const bodyBuf = Buffer.isBuffer(spec.body) ? spec.body : Buffer.from(spec.body ?? "");
          const stream: any = new Readable({ read() {} });
          stream.socket = { remoteAddress: address };
          setImmediate(() => {
            cb(Object.assign(stream, {
              statusCode: spec.status ?? 200,
              headers: { "content-type": "text/html", ...(spec.headers || {}) },
            }));
            setImmediate(() => {
              if (spec.abort) { stream.emit("aborted"); return; }
              stream.push(bodyBuf);
              stream.push(null);
            });
          });
        });
      },
    };
    return req;
  };
  return requestFn;
}

function deps(rec: Recorder, dns: Record<string, string[]> | ((h: string, call: number) => string[]), plan: StubResponse[] | ((hop: number) => StubResponse)): SafeFetchDeps {
  const perHost: Record<string, number> = {};
  const transport = makeTransport(rec, plan);
  return {
    resolve: async (hostname: string) => {
      rec.dnsCalls.push(hostname);
      perHost[hostname] = (perHost[hostname] ?? 0) + 1;
      const answer = typeof dns === "function" ? dns(hostname, perHost[hostname]) : dns[hostname];
      if (!answer) throw new Error("NXDOMAIN");
      return answer;
    },
    request: transport,
    httpRequest: transport,
  };
}
const newRec = (): Recorder => ({ connects: [], dnsCalls: [] });

async function main() {
  console.log("\nURL + SSRF security\n");

  // =====================================================================
  console.log("Address classification — IPv4");
  // =====================================================================

  await check("blocks every reserved / private / loopback IPv4 range", () => {
    const blocked = [
      "127.0.0.1", "127.1.2.3", "0.0.0.0", "0.1.2.3",
      "10.0.0.1", "10.255.255.255",
      "100.64.0.1", "100.127.255.255",          // carrier-grade NAT
      "169.254.169.254", "169.254.0.1",          // link-local + cloud metadata
      "172.16.0.1", "172.31.255.255",
      "192.0.0.1", "192.0.2.5",                  // protocol assignments / TEST-NET-1
      "192.168.0.1", "192.168.255.255",
      "198.18.0.1", "198.19.255.255",            // benchmarking
      "198.51.100.4", "203.0.113.9",             // documentation
      "224.0.0.1", "239.255.255.255",            // multicast
      "240.0.0.1", "255.255.255.255",            // reserved / broadcast
    ];
    for (const ip of blocked) assert(isBlockedAddress(ip), `${ip} must be BLOCKED`);
  });

  await check("allows ordinary public IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "100.63.255.255", "192.0.3.1"]) {
      assert(!isBlockedAddress(ip), `${ip} should be allowed`);
    }
  });

  await check("refuses non-canonical IPv4 forms rather than guessing", () => {
    // 0177.0.0.1 / 0x7f.1 style forms resolve to loopback in some parsers.
    for (const ip of ["0177.0.0.1", "0x7f.0.0.1", "127.1", "2130706433", "010.0.0.1", "1.2.3.4.5", ""]) {
      assert(isBlockedAddress(ip), `${ip} must be refused`);
    }
  });

  // =====================================================================
  console.log("\nAddress classification — IPv6");
  // =====================================================================

  await check("blocks loopback / unspecified / ULA / link-local / multicast / doc IPv6", () => {
    const blocked = ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "2001:db8::1", "100::1", "2001::1"];
    for (const ip of blocked) assert(isBlockedAddress(ip), `${ip} must be BLOCKED`);
  });

  await check("allows ordinary public IPv6", () => {
    for (const ip of ["2606:4700:4700::1111", "2404:6800:4003::1", "2a00:1450:4001::200e"]) {
      assert(!isBlockedAddress(ip), `${ip} should be allowed`);
    }
  });

  await check("CORE: IPv4-mapped IPv6 inherits the FULL IPv4 policy", () => {
    // Without this, every IPv4 rule is bypassable just by rewriting the address.
    const blocked = [
      "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:10.0.0.1",
      "::ffff:192.168.1.1", "::ffff:172.16.0.1", "::ffff:100.64.0.1", "::ffff:0.0.0.0",
      "::ffff:7f00:1",           // the same loopback written as hex groups
    ];
    for (const ip of blocked) assert(isBlockedAddress(ip), `${ip} must be BLOCKED`);
    assert(!isBlockedAddress("::ffff:8.8.8.8"), "mapped PUBLIC v4 should be allowed");
  });

  await check("blocks IPv4-compatible IPv6 and zone-indexed link-local", () => {
    assert(isBlockedAddress("::127.0.0.1"), "IPv4-compatible loopback must be blocked");
    assert(isBlockedAddress("fe80::1%eth0"), "zone index must not defeat link-local blocking");
  });

  // =====================================================================
  console.log("\nHostname + URL validation");
  // =====================================================================

  await check("blocks internal hostnames before any DNS lookup", () => {
    for (const h of ["localhost", "LOCALHOST", "localhost.", "foo.localhost", "svc.internal", "printer.local",
                     "metadata.google.internal", "metadata", "instance-data", "169.254.169.254"]) {
      assert(isBlockedHostname(h), `${h} must be blocked`);
    }
    assert(!isBlockedHostname("example.com"), "public host should pass");
  });

  await check("accepts valid https and http URLs", () => {
    assert(validateUrl("https://example.com/a").ok, "https should be accepted");
    assert(validateUrl("http://example.com/a").ok, "http should be accepted — insecure, but supported");
  });

  await check("rejects unsupported protocols", () => {
    for (const u of ["file:///etc/passwd", "ftp://x.com/a", "gopher://x.com", "data:text/html,<b>x", "javascript:alert(1)",
                     "blob:https://x.com/1", "ws://x.com", "wss://x.com", "chrome://settings", "about:blank"]) {
      const r = validateUrl(u);
      assert(!r.ok, `${u} must be rejected`);
      assert(r.reason === "unsupported_protocol" || r.reason === "invalid_url", `${u} -> ${r.reason}`);
    }
  });

  await check("rejects embedded credentials", () => {
    const r = validateUrl("https://user:pass@example.com/a");
    assert(!r.ok && r.reason === "embedded_credentials", `expected embedded_credentials, got ${r.reason}`);
    assert(!validateUrl("https://user@example.com/a").ok, "username-only must also be rejected");
  });

  await check("rejects malformed and over-long URLs", () => {
    assert(!validateUrl("not a url").ok, "malformed must be rejected");
    assert(!validateUrl("").ok, "empty must be rejected");
    const long = "https://example.com/" + "a".repeat(MAX_URL_LENGTH);
    const r = validateUrl(long);
    assert(!r.ok && r.reason === "url_too_long", `expected url_too_long, got ${r.reason}`);
  });

  await check("canonicalization strips fragments, tracking params and default ports", () => {
    assert(canonicalizeUrl("https://Example.com:443/a?b=1#section") === "https://example.com/a?b=1", canonicalizeUrl("https://Example.com:443/a?b=1#section"));
    assert(canonicalizeUrl("https://example.com/a?utm_source=x&id=7&fbclid=z") === "https://example.com/a?id=7", canonicalizeUrl("https://example.com/a?utm_source=x&id=7&fbclid=z"));
    // Fragments are never sent to a server, so two URLs differing only by
    // fragment are the SAME document — this is what makes dedupe correct.
    assert(canonicalizeUrl("https://example.com/a#one") === canonicalizeUrl("https://example.com/a#two"), "fragments must not distinguish documents");
    assert(canonicalizeUrl("http://example.com:80/") === "http://example.com", "default port + root slash normalised");
  });

  // =====================================================================
  console.log("\nSSRF at CONNECT time");
  // =====================================================================

  await check("a public hostname resolving to a PRIVATE address is refused", async () => {
    const rec = newRec();
    const res = await safeFetch("https://evil.test/a", deps(rec, { "evil.test": ["10.0.0.5"] }, [{ body: "<p>x</p>" }]));
    assert(!res.ok && res.category === "blocked_destination", `expected blocked_destination, got ${(res as any).category}`);
    assert(rec.connects.length === 0, "NO connection may be attempted to a private address");
  });

  await check("a hostname resolving to MIXED public + private is refused entirely", async () => {
    const rec = newRec();
    const res = await safeFetch("https://evil.test/a", deps(rec, { "evil.test": ["93.184.216.34", "169.254.169.254"] }, [{ body: "<p>x</p>" }]));
    assert(!res.ok && res.category === "blocked_destination", `expected blocked_destination, got ${(res as any).category}`);
    assert(rec.connects.length === 0, "a mixed answer must not be cherry-picked into a connection");
  });

  await check("cloud metadata is unreachable by address AND by name", async () => {
    const rec = newRec();
    const byIp = await safeFetch("http://169.254.169.254/latest/meta-data/", deps(rec, {}, [{ body: "creds" }]));
    assert(!byIp.ok, "metadata IP must be refused");
    const byName = await safeFetch("http://metadata.google.internal/computeMetadata/v1/", deps(rec, {}, [{ body: "creds" }]));
    assert(!byName.ok, "metadata hostname must be refused");
    assert(rec.connects.length === 0, "no metadata connection may be attempted");
    assert(rec.dnsCalls.length === 0, "a blocked hostname must not even be resolved");
  });

  await check("IPv6 loopback/ULA literals are refused", async () => {
    const rec = newRec();
    for (const u of ["http://[::1]:6379/", "http://[fd00::1]/x", "http://[fe80::1]/x"]) {
      const res = await safeFetch(u, deps(rec, {}, [{ body: "x" }]));
      assert(!res.ok, `${u} must be refused`);
    }
    assert(rec.connects.length === 0, "no IPv6 internal connection may be attempted");
  });

  await check("CORE: the socket is PINNED to the validated address", async () => {
    const rec = newRec();
    const res = await safeFetch("https://news.test/a", deps(rec, { "news.test": ["93.184.216.34"] }, [{ body: "<p>" + "a".repeat(80) + "</p>" }]));
    assert(res.ok, `expected success, got ${(res as any).category}`);
    assert(rec.connects.length === 1, `expected 1 connection, got ${rec.connects.length}`);
    assert(rec.connects[0].address === "93.184.216.34", `connected to ${rec.connects[0].address}, not the validated address`);
    // The real hostname must survive for TLS SNI + Host, or certificate
    // validation would be against an IP and effectively meaningless.
    assert(rec.connects[0].servername === "news.test", `SNI was ${rec.connects[0].servername}`);
    assert(rec.connects[0].hostname === "news.test", "Host must remain the real hostname");
    assert((res as any).connectedAddresses[0] === "93.184.216.34", "reported connected address is wrong");
  });

  await check("CORE: DNS REBINDING between validation and connect cannot move the socket", async () => {
    const rec = newRec();
    // First answer (validation) is public; every later answer is the metadata
    // service. A client that re-resolves at connect time lands on 169.254.169.254.
    const rebinding = (_h: string, call: number) => (call === 1 ? ["93.184.216.34"] : ["169.254.169.254"]);
    const res = await safeFetch("https://rebind.test/a", deps(rec, rebinding, [{ body: "<p>" + "a".repeat(80) + "</p>" }]));
    assert(res.ok, `expected success, got ${(res as any).category}`);
    assert(rec.dnsCalls.length === 1, `DNS was consulted ${rec.dnsCalls.length}× — it must be resolved ONCE and pinned`);
    assert(rec.connects[0].address === "93.184.216.34", `REBOUND: socket went to ${rec.connects[0].address}`);
  });

  await check("no cookies, Authorization, or API keys are ever sent", async () => {
    const rec = newRec();
    await safeFetch("https://news.test/a", deps(rec, { "news.test": ["93.184.216.34"] }, [{ body: "<p>" + "a".repeat(80) + "</p>" }]));
    const h = Object.keys(rec.connects[0].headers).map((k) => k.toLowerCase());
    for (const forbidden of ["cookie", "authorization", "x-api-key", "proxy-authorization"]) {
      assert(!h.includes(forbidden), `${forbidden} must never be forwarded`);
    }
    assert(!/key|token|secret|password/i.test(JSON.stringify(rec.connects[0].headers)), "no secret-shaped header may be sent");
  });

  // =====================================================================
  console.log("\nRedirects");
  // =====================================================================

  await check("a redirect to a PRIVATE address is blocked at the new hop", async () => {
    const rec = newRec();
    const res = await safeFetch(
      "https://news.test/a",
      deps(rec, { "news.test": ["93.184.216.34"], "internal.test": ["10.1.2.3"] },
        (hop) => (hop === 0 ? { status: 302, headers: { location: "https://internal.test/secret" } } : { body: "SECRET" }))
    );
    assert(!res.ok && res.category === "redirect_blocked", `expected redirect_blocked, got ${(res as any).category}`);
    assert(rec.connects.length === 1, "only the first (public) hop may be connected to");
  });

  await check("a redirect to localhost is blocked", async () => {
    const rec = newRec();
    const res = await safeFetch(
      "https://news.test/a",
      deps(rec, { "news.test": ["93.184.216.34"] },
        (hop) => (hop === 0 ? { status: 302, headers: { location: "http://localhost:6379/" } } : { body: "x" }))
    );
    assert(!res.ok && res.category === "redirect_blocked", `expected redirect_blocked, got ${(res as any).category}`);
    assert(rec.connects.length === 1, "the redirect target must not be dialled");
  });

  await check("a redirect to an unsupported protocol is blocked", async () => {
    const rec = newRec();
    const res = await safeFetch(
      "https://news.test/a",
      deps(rec, { "news.test": ["93.184.216.34"] },
        (hop) => (hop === 0 ? { status: 302, headers: { location: "file:///etc/passwd" } } : { body: "x" }))
    );
    assert(!res.ok && res.category === "redirect_blocked", `expected redirect_blocked, got ${(res as any).category}`);
  });

  await check("a redirect carrying credentials is blocked", async () => {
    const rec = newRec();
    const res = await safeFetch(
      "https://news.test/a",
      deps(rec, { "news.test": ["93.184.216.34"] },
        (hop) => (hop === 0 ? { status: 302, headers: { location: "https://u:p@other.test/x" } } : { body: "x" }))
    );
    assert(!res.ok && res.category === "redirect_blocked", `expected redirect_blocked, got ${(res as any).category}`);
  });

  await check("a redirect LOOP terminates at the limit", async () => {
    const rec = newRec();
    const res = await safeFetch(
      "https://news.test/a",
      deps(rec, { "news.test": ["93.184.216.34"] }, () => ({ status: 302, headers: { location: "https://news.test/a" } }))
    );
    assert(!res.ok && res.category === "too_many_redirects", `expected too_many_redirects, got ${(res as any).category}`);
    assert(rec.connects.length === FETCH_LIMITS.maxRedirects + 1, `expected ${FETCH_LIMITS.maxRedirects + 1} hops, got ${rec.connects.length}`);
  });

  await check("each redirect hop is INDEPENDENTLY resolved and validated", async () => {
    const rec = newRec();
    const res = await safeFetch(
      "https://a.test/1",
      deps(rec, { "a.test": ["93.184.216.34"], "b.test": ["1.1.1.1"] },
        (hop) => (hop === 0 ? { status: 301, headers: { location: "https://b.test/2" } } : { body: "<p>" + "z".repeat(80) + "</p>" }))
    );
    assert(res.ok, `expected success, got ${(res as any).category}`);
    assert(rec.dnsCalls.join(",") === "a.test,b.test", `each hop must resolve: got ${rec.dnsCalls.join(",")}`);
    assert(rec.connects[1].address === "1.1.1.1" && rec.connects[1].servername === "b.test", "hop 2 must be pinned to ITS validated address");
    assert((res as any).redirectCount === 1, "redirect count wrong");
  });

  // =====================================================================
  console.log("\nFetch limits + response validation");
  // =====================================================================

  await check("a hanging server hits the timeout instead of waiting forever", async () => {
    const rec = newRec();
    const res = await safeFetch("https://slow.test/a", deps(rec, { "slow.test": ["93.184.216.34"] }, [{ hang: true }]));
    assert(!res.ok && res.category === "timeout", `expected timeout, got ${(res as any).category}`);
  });

  await check("an oversized body is refused by content-length WITHOUT streaming it", async () => {
    const rec = newRec();
    const res = await safeFetch("https://big.test/a", deps(rec, { "big.test": ["93.184.216.34"] },
      [{ headers: { "content-length": String(FETCH_LIMITS.maxCompressedBytes + 1) }, body: "x" }]));
    assert(!res.ok && res.category === "response_too_large", `expected response_too_large, got ${(res as any).category}`);
  });

  await check("an oversized body that LIES about its length is still stopped mid-stream", async () => {
    const rec = newRec();
    const huge = Buffer.alloc(FETCH_LIMITS.maxCompressedBytes + 1024, 0x61);
    const res = await safeFetch("https://big.test/a", deps(rec, { "big.test": ["93.184.216.34"] }, [{ body: huge }]));
    assert(!res.ok && res.category === "response_too_large", `expected response_too_large, got ${(res as any).category}`);
  });

  await check("unsupported content types are refused", async () => {
    const rec = newRec();
    for (const ct of ["application/pdf", "image/png", "video/mp4", "audio/mpeg", "application/zip",
                      "application/octet-stream", "application/javascript", "application/json"]) {
      const res = await safeFetch("https://x.test/a", deps(rec, { "x.test": ["93.184.216.34"] }, [{ headers: { "content-type": ct }, body: "x" }]));
      assert(!res.ok && res.category === "unsupported_content_type", `${ct} must be refused, got ${(res as any).category}`);
    }
  });

  await check("allowed article content types are accepted", async () => {
    for (const ct of ["text/html; charset=utf-8", "text/plain", "application/xhtml+xml"]) {
      const rec = newRec();
      const res = await safeFetch("https://x.test/a", deps(rec, { "x.test": ["93.184.216.34"] }, [{ headers: { "content-type": ct }, body: "<p>" + "a".repeat(80) + "</p>" }]));
      assert(res.ok, `${ct} should be accepted, got ${(res as any).category}`);
    }
  });

  await check("an aborted stream fails cleanly rather than returning a partial article", async () => {
    const rec = newRec();
    const res = await safeFetch("https://x.test/a", deps(rec, { "x.test": ["93.184.216.34"] }, [{ abort: true }]));
    assert(!res.ok && res.category === "fetch_failed", `expected fetch_failed, got ${(res as any).category}`);
  });

  await check("invalid compression fails cleanly", async () => {
    const rec = newRec();
    const res = await safeFetch("https://x.test/a", deps(rec, { "x.test": ["93.184.216.34"] },
      [{ headers: { "content-encoding": "gzip" }, body: Buffer.from("this is definitely not gzip") }]));
    assert(!res.ok && res.category === "fetch_failed", `expected fetch_failed, got ${(res as any).category}`);
  });

  await check("a non-2xx response is not treated as an article", async () => {
    const rec = newRec();
    const res = await safeFetch("https://x.test/a", deps(rec, { "x.test": ["93.184.216.34"] }, [{ status: 404, body: "nope" }]));
    assert(!res.ok && res.category === "fetch_failed", `expected fetch_failed, got ${(res as any).category}`);
  });

  await check("a DNS failure is reported as such", async () => {
    const rec = newRec();
    const res = await safeFetch("https://nx.test/a", deps(rec, {}, [{ body: "x" }]));
    assert(!res.ok && res.category === "dns_resolution_failed", `expected dns_resolution_failed, got ${(res as any).category}`);
  });

  await check("error messages leak no address, path or internal detail to the caller", async () => {
    const rec = newRec();
    const res = await safeFetch("https://evil.test/a", deps(rec, { "evil.test": ["169.254.169.254"] }, [{ body: "x" }]));
    assert(!res.ok, "must fail");
    const msg = (res as any).message as string;
    assert(!/169\.254|10\.0\.0|127\.0\.0|::1/.test(msg), `browser-facing message leaked an address: ${msg}`);
    assert(!/at \w+ \(|\.ts:\d+/.test(msg), `browser-facing message leaked a stack trace: ${msg}`);
    // The operator detail still exists for the server log.
    assert(typeof (res as any).internal === "string" && (res as any).internal.length > 0, "operator detail should be captured server-side");
  });

  // =====================================================================
  console.log("\nExtraction + sanitization");
  // =====================================================================

  const HOSTILE = `<!doctype html><html><head>
    <title>Real Title &amp; More</title>
    <meta property="og:site_name" content="Example News">
    <meta name="author" content="Jane <script>alert(1)</script> Doe">
    <meta property="article:published_time" content="2026-07-01T10:00:00Z">
    <link rel="canonical" href="https://example.com/canonical-path?utm_source=x#frag">
    <script>window.__stolen = document.cookie; var evil="SECRETPAYLOAD";</script>
    <style>body{background:url('javascript:alert(1)')}</style>
    </head><body>
    <iframe src="http://169.254.169.254/latest/meta-data/"></iframe>
    <svg><script>alert('svg')</script></svg>
    <p onclick="alert('handler')">${"The reporting body text that is definitely long enough to be kept as an excerpt. ".repeat(2)}</p>
    <p>${"A second paragraph of real article content, also comfortably past the minimum length. ".repeat(2)}</p>
    <object data="evil.swf"></object><embed src="evil.swf">
    </body></html>`;

  await check("extracts title, site, author, date and canonical URL", () => {
    const a = extractArticle(HOSTILE, "https://example.com/orig");
    assert(a.title === "Real Title & More", `title: ${a.title}`);
    assert(a.siteName === "Example News", `siteName: ${a.siteName}`);
    assert(!!a.publishedAt?.toISOString().startsWith("2026-07-01"), `publishedAt: ${a.publishedAt}`);
    // The page's canonical is honoured, canonicalized (tracking + fragment gone).
    assert(a.canonicalUrl === "https://example.com/canonical-path", `canonicalUrl: ${a.canonicalUrl}`);
  });

  await check("CORE: no script, handler, iframe or style content survives into the excerpt", () => {
    const a = extractArticle(HOSTILE, "https://example.com/orig");
    const all = `${a.excerpt} ${a.title} ${a.author} ${a.siteName}`;
    for (const bad of ["<script", "alert(", "SECRETPAYLOAD", "document.cookie", "<iframe", "169.254.169.254", "onclick", "javascript:", "<object", "<embed", "<svg"]) {
      assert(!all.includes(bad), `sanitization leaked ${bad}`);
    }
    assert(!/[<>]/.test(all), "no angle brackets may survive — nothing can re-form an element");
  });

  await check("malicious metadata is neutralised — the payload is removed, the real name kept", () => {
    const a = extractArticle(HOSTILE, "https://example.com/orig");
    assert(a.author === "Jane Doe", `author was not neutralised: ${a.author}`);
    assert(!a.author!.includes("<") && !a.author!.includes("alert"), "author must carry neither markup nor its payload");
  });

  await check("real article text is extracted", () => {
    const a = extractArticle(HOSTILE, "https://example.com/orig");
    assert(a.excerpt.includes("The reporting body text"), "first paragraph missing");
    assert(a.excerpt.includes("A second paragraph"), "second paragraph missing");
    assert(a.excerpt.length <= FETCH_LIMITS.maxExtractedChars, "excerpt exceeds the cap");
  });

  await check("excerpt is capped at the extraction limit", () => {
    const giant = `<html><body><p>${"word ".repeat(60_000)}</p></body></html>`;
    const a = extractArticle(giant, "https://example.com/x");
    assert(a.excerpt.length <= FETCH_LIMITS.maxExtractedChars, `excerpt ${a.excerpt.length} exceeds cap`);
  });

  await check("content hash is stable and content-sensitive", () => {
    const a = extractArticle(HOSTILE, "https://example.com/orig");
    const b = extractArticle(HOSTILE, "https://example.com/orig");
    const c = extractArticle(HOSTILE + "<p>different</p>", "https://example.com/orig");
    assert(a.contentHash === b.contentHash, "same content must hash the same");
    assert(a.contentHash !== c.contentHash, "different content must hash differently");
    assert(/^[a-f0-9]{64}$/.test(a.contentHash), "expected a sha256 hex digest");
  });

  await check("a javascript: canonical link is ignored, not stored", () => {
    const html = `<html><head><link rel="canonical" href="javascript:alert(1)"><title>t</title></head><body><p>${"x".repeat(80)}</p></body></html>`;
    const a = extractArticle(html, "https://example.com/real");
    assert(a.canonicalUrl === "https://example.com/real", `unsafe canonical was accepted: ${a.canonicalUrl}`);
  });

  await check("a quoted attribute is read to ITS OWN closing quote", () => {
    // Regression: a `[^"']*` capture stops at the first apostrophe, which both
    // mangles ordinary metadata AND can sever a hostile value mid-tag so the
    // orphaned fragment survives sanitization.
    const html = `<html><head><title>t</title>
      <meta name="author" content="Se&#225;n O'Brien">
      <meta property="og:site_name" content='The "Daily" Wire'>
      </head><body><p>${"x".repeat(80)}</p></body></html>`;
    const a = extractArticle(html, "https://example.com/x");
    assert(a.author === "Seán O'Brien", `apostrophe truncated the author: '${a.author}'`);
    assert(a.siteName === 'The "Daily" Wire', `single-quoted attribute mis-parsed: '${a.siteName}'`);
  });

  await check("a script inside a meta attribute is removed WITH its payload", () => {
    const html = `<html><head><title>t</title>
      <meta name="author" content="Eve <script>alert('xss')</script> Adversary">
      </head><body><p>${"x".repeat(80)}</p></body></html>`;
    const a = extractArticle(html, "https://example.com/x");
    assert(a.author === "Eve Adversary", `payload survived in author: '${a.author}'`);
    assert(!a.author!.includes("alert"), "the script payload must not survive as text");
  });

  await check("entity-encoded and double-encoded tags cannot re-form an element", () => {
    const html = `<html><head>
      <meta property="og:title" content="&#60;script&#62;alert(1)&#60;/script&#62; Headline">
      <meta name="author" content="&amp;#60;script&amp;#62; Byline">
      </head><body><p>${"x".repeat(80)}</p></body></html>`;
    const a = extractArticle(html, "https://example.com/x");
    // The property that matters is that NO element can re-form. Brackets are
    // the thing to ban — not the harmless word "script".
    for (const v of [a.title, a.author]) {
      assert(!/[<>]/.test(v ?? ""), `an encoded tag re-formed brackets: '${v}'`);
    }
    // Single-encoded: decodes to a real <script>, which is removed with its payload.
    assert(!/script/i.test(a.title ?? ""), `a decoded script survived in the title: '${a.title}'`);
    assert(!/alert/.test(a.title ?? ""), `the payload survived in the title: '${a.title}'`);
    assert(a.title!.includes("Headline"), `the real title text was lost: '${a.title}'`);
    // Double-encoded: decoding ONCE yields the literal text "&#60;script&#62;".
    // Keeping it as inert text is correct — decoding it again would be the bug.
    assert(a.author === "&#60;script&#62; Byline", `double-decoded (or mangled) the author: '${a.author}'`);
  });

  await check("plain text imports without metadata invention", () => {
    const a = extractArticle("Just some plain text reporting.", "https://example.com/t.txt", "text/plain");
    assert(a.excerpt === "Just some plain text reporting.", `excerpt: ${a.excerpt}`);
    assert(a.title === null && a.author === null, "plain text must not invent metadata");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
