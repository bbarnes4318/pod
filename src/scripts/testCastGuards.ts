// Guards for the Zabala/Mulkey cast.
//
// Mulkey's defining rhetorical device is ESCALATING REPETITION — a name said
// three times, louder each time, used as an argument. That is structurally
// adjacent to the banned antithesis frame (both are two/three-part balanced
// constructions), so the detector shipped in #53 is the thing most likely to
// mistake his character for a defect and rewrite it away.
//
// These assertions pin the boundary: repetition is not antithesis. If the
// detector ever starts flagging his triples, that is a bug in the detector,
// not a reason to change the character.

import { findAntithesis } from "../lib/services/scriptAntithesis";
import { deriveProfileFromHostFields } from "../lib/hosts/performanceProfile";

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

console.log("Cast guards: repetition vs antithesis\n");

// Every one of these is a real Mulkey device from the bible. None is an
// antithesis. All must survive the rewrite loop untouched.
const MULKEY_REPETITION = [
  "Hoyt. HOYT. DUANE HOYT.",
  "I was IN that building. IN it. I was IN THAT BUILDING.",
  "He is no Duane Hoyt. HE IS NO DUANE HOYT.",
  "Ladies and gentlemen — LADIES AND GENTLEMEN.",
  "OH! Oh. OH!",
  "Forty feet. FORTY FEET.",
  "Six thousand, four hundred and NINE-ty-two.",
  "That is a walk-up music problem. A walk-up music PROBLEM.",
  "Nineteen years. Nineteen. Every home date.",
  "Petey Vandersloot. Vandersloot! You do not forget a Vandersloot.",
];

// Controls: real antithesis. If these stop being caught the detector has been
// broken in the other direction and this test is no longer meaningful.
const REAL_ANTITHESIS = [
  "That is not a rebuild, that is a fire sale.",
  "That wasn't effort. That was a coaching decision.",
  "This isn't about money, it's about respect.",
  "Not a slump, a collapse.",
];

check("Mulkey's escalating repetition is NEVER flagged as antithesis", () => {
  const wrong: string[] = [];
  for (const line of MULKEY_REPETITION) {
    const hits = findAntithesis(line);
    if (hits.length > 0) wrong.push(`${line}  → ${hits.map((h) => h.kind).join(",")}`);
  }
  assert(
    wrong.length === 0,
    `the detector must not mistake repetition for antithesis, but flagged:\n      ${wrong.join("\n      ")}`
  );
});

check("the detector still catches genuine antithesis (control)", () => {
  const missed = REAL_ANTITHESIS.filter((l) => findAntithesis(l).length === 0);
  assert(
    missed.length === 0,
    `these are real antithesis frames and must still be caught:\n      ${missed.join("\n      ")}`
  );
});

check("a triple repeat carrying a real antithesis inside it is still caught", () => {
  // The character device does not grant immunity: if he wraps a banned frame in
  // repetition, the frame is still banned.
  const hits = findAntithesis("HOYT. HOYT. That is not a receiver, that is a standard.");
  assert(hits.length > 0, "repetition must not be usable as a wrapper to smuggle antithesis past the detector");
});

// --- performance energy is not seating rank --------------------------------
//
// intensityLevel decides WHICH SEAT a host takes (hostCasting sorts by it).
// Deriving performance energy from it put a loud character in a quiet
// performance. Both directions are pinned: a loud style at a low rank must
// stay big, and a reserved style at a high rank must stay small.

check("a LOUD style at intensity 5 derives assertive/natural/theatrical", () => {
  const p = deriveProfileFromHostFields({
    speakingStyle:
      "ENORMOUS trained PA projection. Barked HAW of a laugh on top of his own punchlines. " +
      "Slaps the desk, whoops. Interrupts by out-volumeing, never by waiting. Louder and SLOWER under pressure.",
    intensityLevel: 5,
  });
  assert(p.laughBehavior === "natural", `laughBehavior is '${p.laughBehavior}' — a barked laugh is not "rare"`);
  assert(p.interruptionBehavior === "assertive", `interruptionBehavior is '${p.interruptionBehavior}' — he interrupts by out-volumeing`);
  assert(p.killShotBehavior === "theatrical", `killShotBehavior is '${p.killShotBehavior}' — whooping and desk-slapping is not "measured"`);
  assert(p.angerStyle === "louder_slower", `angerStyle is '${p.angerStyle}'`);
});

check("a RESERVED style at intensity 8 still derives rare/measured", () => {
  const p = deriveProfileFromHostFields({
    speakingStyle:
      "Quiet and clipped. Rarely laughs. Waits for a gap and lets him finish. Understated, clinical, never raises his voice.",
    intensityLevel: 8,
  });
  assert(p.laughBehavior === "rare", `laughBehavior is '${p.laughBehavior}' — high rank must not force laughter`);
  assert(p.interruptionBehavior === "rare", `interruptionBehavior is '${p.interruptionBehavior}' — he waits for a gap`);
  assert(p.killShotBehavior === "measured", `killShotBehavior is '${p.killShotBehavior}' — understated and clinical`);
});

check("intensityLevel is still the fallback when the style text is silent", () => {
  const hot = deriveProfileFromHostFields({ speakingStyle: "talks about sports", intensityLevel: 9 });
  assert(hot.interruptionBehavior === "assertive" && hot.killShotBehavior === "theatrical", "a silent style at a high rank falls back to hot");
  const calm = deriveProfileFromHostFields({ speakingStyle: "talks about sports", intensityLevel: 3 });
  assert(calm.interruptionBehavior === "rare" && calm.killShotBehavior === "measured", "a silent style at a low rank falls back to calm");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
