// URL + destination safety for OUTBOUND fetches of operator/remote-supplied
// links. Pure functions only — no I/O — so every rule here is exhaustively
// unit-testable without a network.
//
// THREAT MODEL
// An attacker who controls a URL (an admin-pasted link, or a <link> inside a
// third-party RSS feed) tries to make OUR server issue a request it wouldn't
// otherwise make, to somewhere it shouldn't reach:
//   • directly, via http://169.254.169.254/ (cloud instance metadata),
//     http://127.0.0.1:6379 (our Redis), http://10.x (internal services);
//   • indirectly, via a public hostname whose DNS answer is a private address;
//   • via a redirect from a public page to any of the above;
//   • via DNS rebinding: answer public while we validate, private when the
//     socket actually connects.
// The last one is why classification alone is not a defence: it must be paired
// with pinning the connection to the exact address that was validated
// (src/lib/net/safeFetch.ts).
//
// No dependency does this for us — there is no undici/ipaddr.js in this project
// — so the ranges below are implemented against Node's `net` built-in.

import net from "node:net";

/** Only these schemes may ever be fetched. */
export const ALLOWED_PROTOCOLS = ["http:", "https:"] as const;

/** Hard ceiling on a URL we will even parse. */
export const MAX_URL_LENGTH = 2048;

/** Hostnames that must never be resolved, regardless of what DNS would say. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  // Cloud instance metadata services. These resolve to link-local addresses
  // (already blocked below), but naming them means a request is refused before
  // a single DNS packet leaves the box.
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "169.254.169.254",
  "fd00:ec2::254",
]);

/** Any hostname under one of these suffixes is internal by construction. */
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain"];

export type BlockedReason =
  | "invalid_url"
  | "unsupported_protocol"
  | "embedded_credentials"
  | "url_too_long"
  | "blocked_hostname"
  | "blocked_address";

export interface UrlCheck {
  ok: boolean;
  reason?: BlockedReason;
  detail?: string;
}

/* ------------------------------------------------------------------ */
/* IPv4                                                                */
/* ------------------------------------------------------------------ */

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    // Reject non-canonical forms ("010", "0x7f", "1e2") — some parsers accept
    // them and resolve somewhere different than a human reviewer expects.
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    if (p.length > 1 && p[0] === "0") return null;
    out = out * 256 + n;
  }
  return out >>> 0;
}

/** [network, prefixLength] pairs that must never be a fetch destination. */
const BLOCKED_V4_CIDRS: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network" / unspecified
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (includes 169.254.169.254 metadata)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1 documentation
  ["192.88.99.0", 24], // deprecated 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2 documentation
  ["203.0.113.0", 24], // TEST-NET-3 documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved (includes 255.255.255.255 broadcast)
];

function v4Blocked(ip: string): boolean {
  const addr = ipv4ToInt(ip);
  if (addr === null) return true; // unparseable → refuse
  for (const [network, bits] of BLOCKED_V4_CIDRS) {
    const net32 = ipv4ToInt(network);
    if (net32 === null) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((addr & mask) >>> 0 === (net32 & mask) >>> 0) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* IPv6                                                                */
/* ------------------------------------------------------------------ */

/** Expand an IPv6 address to its 16 bytes. Returns null if unparseable. */
function ipv6ToBytes(ip: string): Uint8Array | null {
  let addr = ip;
  // Strip a zone index ("fe80::1%eth0") — it never changes the address itself.
  const pct = addr.indexOf("%");
  if (pct !== -1) addr = addr.slice(0, pct);

  // An embedded IPv4 tail (::ffff:127.0.0.1) becomes two hex groups.
  const lastColon = addr.lastIndexOf(":");
  const tail = lastColon === -1 ? "" : addr.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tailGroups = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  if (halves.length === 1 && head.length !== 8) return null;

  const fill = 8 - head.length - tailGroups.length;
  if (fill < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...tailGroups];
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i] === "" ? "0" : groups[i];
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes[i * 2] = (v >> 8) & 0xff;
    bytes[i * 2 + 1] = v & 0xff;
  }
  return bytes;
}

function isV4Mapped(b: Uint8Array): boolean {
  // ::ffff:0:0/96
  for (let i = 0; i < 10; i++) if (b[i] !== 0) return false;
  return b[10] === 0xff && b[11] === 0xff;
}

function v6Blocked(ip: string): boolean {
  const b = ipv6ToBytes(ip);
  if (!b) return true; // unparseable → refuse

  // IPv4-mapped (::ffff:a.b.c.d) — apply the FULL IPv4 policy, otherwise every
  // v4 rule above is trivially bypassable by writing the address in v6 form.
  if (isV4Mapped(b)) {
    return v4Blocked(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  }
  // IPv4-compatible (::a.b.c.d, deprecated) — same reasoning.
  const first12Zero = b.slice(0, 12).every((x) => x === 0);
  if (first12Zero && !(b[12] === 0 && b[13] === 0 && b[14] === 0 && b[15] <= 1)) {
    return v4Blocked(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  }

  const allZero = b.every((x) => x === 0);
  if (allZero) return true; // ::/128 unspecified
  if (first12Zero && b[12] === 0 && b[13] === 0 && b[14] === 0 && b[15] === 1) return true; // ::1 loopback

  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32 doc
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && (b[3] & 0xf8) === 0x00) return true; // 2001::/32 Teredo
  if (b[0] === 0x01 && b[1] === 0x00 && b[2] === 0x00 && b[3] === 0x00) return true; // 100::/64 discard
  if (b[0] === 0x00) return true; // anything else in ::/8 is reserved

  return false;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Is this literal IP address forbidden as a fetch destination?
 * Anything not recognisably a public unicast address is refused — the default
 * is DENY, so an address we fail to understand is never dialled.
 */
export function isBlockedAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return v4Blocked(ip);
  if (kind === 6) return v6Blocked(ip);
  return true; // not an IP at all → refuse
}

/** Is this hostname forbidden before we even resolve it? */
export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/\.$/, ""); // trailing dot = same host
  if (!h) return true;
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((s) => h.endsWith(s))) return true;
  // A bare IP literal in the URL is checked directly — no DNS involved.
  const bare = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  if (net.isIP(bare)) return isBlockedAddress(bare);
  return false;
}

/**
 * Parse + validate a candidate URL WITHOUT touching the network.
 * Passing this is necessary but NOT sufficient: the destination address still
 * has to be resolved and validated, and the connection pinned to it.
 */
export function validateUrl(raw: string): UrlCheck & { url?: URL } {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, reason: "invalid_url", detail: "The URL is empty." };
  }
  const candidate = raw.trim();
  if (candidate.length > MAX_URL_LENGTH) {
    return { ok: false, reason: "url_too_long", detail: `The URL exceeds ${MAX_URL_LENGTH} characters.` };
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: "invalid_url", detail: "That isn't a valid URL." };
  }

  if (!(ALLOWED_PROTOCOLS as readonly string[]).includes(url.protocol)) {
    return { ok: false, reason: "unsupported_protocol", detail: `Only http and https are supported (got ${url.protocol}).` };
  }
  // Credentials in a URL would be sent to the destination; they are also a
  // classic way to disguise the real host ("https://trusted.com@evil.test").
  if (url.username || url.password) {
    return { ok: false, reason: "embedded_credentials", detail: "URLs with a username or password are not accepted." };
  }
  if (isBlockedHostname(url.hostname)) {
    return { ok: false, reason: "blocked_hostname", detail: "That destination is not publicly routable." };
  }
  return { ok: true, url };
}

/**
 * Canonical form for storage + duplicate detection.
 *
 * Drops the fragment (never sent to a server, so it cannot identify a distinct
 * document), lowercases the scheme/host, removes the default port and common
 * tracking parameters, and normalises an empty path to "/". Deliberately
 * conservative: it does NOT strip other query params, because for many sites
 * the query IS the article identity.
 */
const TRACKING_PARAMS = [
  /^utm_/i, /^fbclid$/i, /^gclid$/i, /^mc_cid$/i, /^mc_eid$/i,
  /^igshid$/i, /^ref$/i, /^ref_src$/i, /^s_cid$/i, /^cmpid$/i,
];

export function canonicalizeUrl(input: string | URL): string {
  const url = typeof input === "string" ? new URL(input) : new URL(input.toString());
  url.hash = "";
  url.username = "";
  url.password = "";
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
    url.port = "";
  }
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.some((re) => re.test(key))) url.searchParams.delete(key);
  }
  url.searchParams.sort(); // param order isn't document identity
  if (url.pathname === "") url.pathname = "/";
  // A bare trailing slash on the root is noise; deeper paths keep theirs, since
  // /a and /a/ are genuinely different resources on some servers.
  let out = url.toString();
  if (url.pathname === "/" && !url.search) out = out.replace(/\/$/, "");
  return out;
}
