// The seat-B recast, enforced.
//
// Two jobs, both of which are about a failure that does not announce itself:
//
//   1. REMOVAL. A character is not removed when his name stops appearing. He is
//      removed when nothing can bring his behavior back — no seed row, no
//      fallback, no dormant continuity field, no test fixture that a future
//      author copies. So the first half of this file is a repository search
//      with an EXPLICIT allowlist: every surviving mention of the retired
//      character is enumerated here with a reason, and a new one fails the
//      build.
//
//   2. THE CHARACTER. Cal's performance profile is the part of him that reaches
//      TTS, and every property that makes him a different person from his
//      predecessor is one enum string away from being undone. Those strings are
//      pinned below, against the authored roster, with no database needed.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { CAL_PROFILE, SEED_HOSTS, ZABALA_PROFILE, resolveSeatBVoice, PLACEHOLDER_VOICE_ID } from "../lib/hosts/roster";
import { hostPerformanceProfileSchema } from "../lib/hosts/performanceProfile";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}
function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const ROOT = join(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// 1. Repository search
// ---------------------------------------------------------------------------

const BANNED = [
  "Mulkey",
  "dutch-attendance",
  "Duane Hoyt",
  "Wolverine",
  "phantomFans",
  "pronounHunt",
  "weSaidCount",
  "DODGE_LADDER",
  "hoytStage",
  "hoytBeat",
  "hoytFacts",
  "wolverineUsed",
  "attendanceFigure",
  "attendanceClaimed",
  "Attendance Ledger",
  "badgeStage",
  "FISH_MULKEY_VOICE_ID",
];

const ALLOWED: Array<{ path: string; maxLines: number; reason: string }> = [
  { path: "prisma/schema.prisma", maxLines: 14, reason: "the rollback archive table + the comments explaining what was dropped" },
  { path: "src/lib/hosts/roster.ts", maxLines: 5, reason: "the retired slug in RETIRED_HOST_SLUGS + the deprecated seat-B env fallback" },
  { path: "src/scripts/testCastReplacement.ts", maxLines: 60, reason: "this file — it names the tokens in order to ban them" },
  { path: "src/scripts/testHostMigration.ts", maxLines: 40, reason: "proves the migration converts the retired row" },
  { path: "src/scripts/testShowContinuity.ts", maxLines: 14, reason: "proves retired state cannot leak into a prompt" },
  { path: "src/scripts/testLedger.ts", maxLines: 3, reason: "proves a retired-shape claim contributes nothing" },
];

const SCANNED_ROOTS = ["src", "prisma"];
const SCANNED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".json", ".css", ".txt", ".prisma"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "migrations" || entry === "node_modules" || entry === ".next") continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCANNED_EXTENSIONS.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

check("no active production code can resurrect the retired character", () => {
  const files = SCANNED_ROOTS.flatMap((r) => walk(join(ROOT, r)));
  const offences: string[] = [];
  const allowedCounts = new Map<string, number>();

  for (const file of files) {
    const rel = relative(ROOT, file).split(sep).join("/");
    const allowance = ALLOWED.find((a) => a.path === rel);
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    let hits = 0;
    lines.forEach((line, i) => {
      const hit = BANNED.find((t) => line.toLowerCase().includes(t.toLowerCase()));
      if (!hit) return;
      hits++;
      if (!allowance) offences.push(`${rel}:${i + 1}  [${hit}]  ${line.trim().slice(0, 110)}`);
    });
    if (allowance && hits > 0) allowedCounts.set(rel, hits);
  }

  assert(offences.length === 0, `the retired character survives in active code:\n      ${offences.join("\n      ")}`);

  const overruns = ALLOWED.filter((a) => (allowedCounts.get(a.path) ?? 0) > a.maxLines).map(
    (a) => `${a.path}: ${allowedCounts.get(a.path)} lines, cap ${a.maxLines} (${a.reason})`
  );
  assert(overruns.length === 0, `an allowlisted file grew past its cap:\n      ${overruns.join("\n      ")}`);

  const stale = ALLOWED.filter((a) => !allowedCounts.has(a.path)).map((a) => a.path);
  assert(stale.length === 0, `these files no longer need their exemption — delete it: ${stale.join(", ")}`);
});

check("the retired seat-B env var survives ONLY as a marked deprecation", () => {
  const roster = readFileSync(join(ROOT, "src", "lib", "hosts", "roster.ts"), "utf8");
  assert(
    roster.includes("env.FISH_MULKEY_VOICE_ID"),
    "the deprecated fallback is gone entirely — that is a breaking change, not a cleanup; confirm it is intended"
  );
  assert(/DEPRECATED/.test(roster), "the fallback must be marked DEPRECATED in the source");
  const order = ["FISH_HOST_B_VOICE_ID", "FISH_CAL_MERCER_VOICE_ID", "FISH_MULKEY_VOICE_ID"].map((v) =>
    roster.indexOf(`env.${v}`)
  );
  assert(order[0] < order[1] && order[1] < order[2], `the deprecated var must be the LAST env fallback, got order ${order.join(", ")}`);
});

check("seat-B voice resolution prefers the seat var and preserves a working voice", () => {
  const REAL = "36780e7121b84d5c9c24cbd2f15eaaa4";
  const seat = resolveSeatBVoice(REAL, { FISH_HOST_B_VOICE_ID: "aaaa", FISH_CAL_MERCER_VOICE_ID: "bbbb", FISH_MULKEY_VOICE_ID: "cccc" } as unknown as NodeJS.ProcessEnv);
  assert(seat.voiceId === "aaaa", `the seat var must win, got ${seat.voiceId}`);

  const character = resolveSeatBVoice(REAL, { FISH_CAL_MERCER_VOICE_ID: "bbbb", FISH_MULKEY_VOICE_ID: "cccc" } as unknown as NodeJS.ProcessEnv);
  assert(character.voiceId === "bbbb", `the character var must beat the deprecated one, got ${character.voiceId}`);

  const legacy = resolveSeatBVoice(REAL, { FISH_MULKEY_VOICE_ID: "cccc" } as unknown as NodeJS.ProcessEnv);
  assert(legacy.voiceId === "cccc" && legacy.deprecated, "the deprecated var must still resolve, and say that it is deprecated");

  const preserved = resolveSeatBVoice(REAL, {} as unknown as NodeJS.ProcessEnv);
  assert(preserved.voiceId === REAL, `a working voice must be preserved, got ${preserved.voiceId}`);

  const fresh = resolveSeatBVoice(null, {} as unknown as NodeJS.ProcessEnv);
  assert(fresh.voiceId === PLACEHOLDER_VOICE_ID, "a fresh environment falls to the publish-blocking placeholder, never to a guess");
  assert(!/^[0-9a-f]{32}$/i.test(fresh.voiceId), "the placeholder must not be mistakable for a real Fish reference id");
});

// ---------------------------------------------------------------------------
// 2. The character
// ---------------------------------------------------------------------------

const cal = SEED_HOSTS.find((h) => h.slug === "cal-red-eye-mercer")!;
const zabala = SEED_HOSTS.find((h) => h.slug === "bernie-line-two")!;

check("the roster is exactly Zabala (seat A) and Mercer (seat B), in that order", () => {
  assert(SEED_HOSTS.length === 2, `expected 2 hosts, got ${SEED_HOSTS.length}`);
  assert(SEED_HOSTS[0].slug === "bernie-line-two", "Zabala must be index 0 — seat order is load-bearing");
  assert(SEED_HOSTS[1].slug === "cal-red-eye-mercer", "Mercer must be index 1");
  assert(SEED_HOSTS[0].intensityLevel - SEED_HOSTS[1].intensityLevel >= 2, "the seating gap must keep Zabala in chair A");
});

check("Cal's performance profile is VALID against the real schema", () => {
  const parsed = hostPerformanceProfileSchema.safeParse(CAL_PROFILE);
  assert(parsed.success, `the authored profile must validate: ${JSON.stringify(parsed.error?.issues)}`);
});

check("Cal has a moderate baseline and a real lower register — he does not open at his peak", () => {
  const p = hostPerformanceProfileSchema.parse(CAL_PROFILE);
  assert(p.baselineIntensity <= 5, `baselineIntensity ${p.baselineIntensity} is not a moderate opening`);
  assert(p.baselineIntensity >= 3, `baselineIntensity ${p.baselineIntensity} is asleep, not calm`);
  assert(p.peakIntensity > p.baselineIntensity + 1, "a peak that close to the baseline is not a range, it is one volume");
  assert(p.peakIntensity <= 8, `peakIntensity ${p.peakIntensity} is a shouting ceiling`);
  assert(p.baselinePace <= 1.05 && p.maxEscalationPace <= 1.2, "he leans in; he does not sprint");
  assert(p.maxEscalationPace > p.baselinePace, "he must be able to pick up at all — a flat ceiling reads as sleepy");
});

check("Cal can disagree without raising his volume — the mechanical guarantee", () => {
  const p = hostPerformanceProfileSchema.parse(CAL_PROFILE);
  assert(p.angerStyle === "slower_quieter", `angerStyle is '${p.angerStyle}' — his anger must go DOWN`);
  assert(p.killShotBehavior === "measured", `killShotBehavior is '${p.killShotBehavior}'`);
  assert(p.interruptionBehavior !== "assertive", `interruptionBehavior is '${p.interruptionBehavior}' — he does not arrive on top`);
});

check("nothing in Cal's profile prohibits quiet delivery", () => {
  const p = hostPerformanceProfileSchema.parse(CAL_PROFILE);
  const prohibited = p.prohibitedTraits.map((t) => t.toLowerCase());
  for (const t of prohibited) {
    assert(
      !/\bquiet|\bsoft|\bcalm\b|\brestrain|\blow[- ]energy|\bsilence|\bpause/.test(t),
      `'${t}' forbids the register the character is built on`
    );
  }
  assert(prohibited.length > 0, "the profile must actually forbid something, or the list is decorative");
});

check("Cal's profile forbids the announcer traits that defined the previous seat B", () => {
  const prohibited = CAL_PROFILE.prohibitedTraits.map((t) => t.toLowerCase()).join(" | ");
  for (const trait of ["arena projection", "announcer cadence", "constant high energy", "shouting as disagreement", "repetitive catchphrases"]) {
    assert(prohibited.includes(trait), `'${trait}' must be prohibited, got: ${prohibited}`);
  }
});

check("the two hosts never share a behavioral value where a contrast exists", () => {
  const a = hostPerformanceProfileSchema.parse(ZABALA_PROFILE);
  const b = hostPerformanceProfileSchema.parse(CAL_PROFILE);
  for (const key of ["angerStyle", "preferredPauseStyle", "sarcasmBehavior", "laughBehavior", "concessionBehavior", "interruptionBehavior", "killShotBehavior"] as const) {
    assert(a[key] !== b[key], `both hosts share ${key}='${a[key]}' — that is one character in two chairs`);
  }
  assert(a.peakIntensity > b.peakIntensity, "seat B must not out-peak seat A");
});

check("neither active host can be funny by repeating a prewritten line", () => {
  assert(cal.catchphrases.length === 0, `Cal has catchphrases: ${JSON.stringify(cal.catchphrases)}`);
  assert(zabala.catchphrases.length === 0, `Zabala has catchphrases: ${JSON.stringify(zabala.catchphrases)}`);
  assert(zabala.name === "Bernadette Zabala", `the production-label nickname survived in the active name: '${zabala.name}'`);
  assert(zabala.bannedPhrases.some((p) => /line two/i.test(p)), "the literal Line Two artifact must be banned");
});

check("Cal has a desire, an avoidance, and an explicit synthetic-character boundary", () => {
  const w = cal.worldview;
  assert(/WANTS:/.test(w), "no stated desire — a character without one only reacts");
  assert(/AVOIDS:/.test(w), "no stated avoidance — a character without one has nothing to hide");
  assert(/SYNTHETIC SHOW CHARACTER/i.test(w), "the synthetic-character boundary must be stated in the persona the model reads");
  assert(/fictional and composite/i.test(w), "his history must be declared fictional and composite where the model will see it");
  assert(/never claims private knowledge/i.test(w), "he must be forbidden from claiming private knowledge about real people");
});

check("Cal's banned phrases close the routes back to a device", () => {
  const banned = cal.bannedPhrases.map((p) => p.toLowerCase());
  assert(banned.includes("back in my day"), "the nostalgia tic must be banned");
  assert(banned.some((p) => p.includes("happens in the room")), "the process-explainer catchphrase must be banned");
  assert(banned.some((p) => p.includes("i was there") || p.includes("i have sources")), "ungrounded insider authority must be banned");
  assert(banned.includes("ladies and gentlemen"), "announcer residue must be banned");
});

check("Cal's argument patterns are ways of THINKING, not lines to deliver", () => {
  for (const p of cal.argumentPatterns) {
    assert(!/^["“]/.test(p.trim()), `argument pattern is a quoted line, not a move: ${p}`);
    assert(/^[A-Z][a-z]+/.test(p.trim()), `argument pattern should start with a verb describing the move: ${p}`);
  }
  const joined = cal.argumentPatterns.join(" ").toLowerCase();
  assert(joined.includes("memory"), "his use of memory must be described, and bounded");
  assert(/never as a reflex|only when/.test(joined), "the anecdote must be explicitly conditional, or it becomes his every answer");
  assert(joined.includes("quieter"), "his anger direction must be stated in the persona, not only in the profile");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
