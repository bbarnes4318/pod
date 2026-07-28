// Guards for the Zabala/Mercer cast.
//
// The antithesis detector (#53) rewrites lines built on a balanced "not X, but
// Y" frame. Cal Mercer's defining rhetorical device — catching himself using
// institutional language and correcting it mid-sentence — is structurally
// adjacent to that frame: a self-correction states a thing and then replaces
// it, which is two clauses in opposition. So the detector is the thing most
// likely to mistake his character for a defect and rewrite it away.
//
// These assertions pin the boundary: self-correction is not antithesis. If the
// detector ever starts flagging his mid-sentence repairs, that is a bug in the
// detector, not a reason to change the character.

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

console.log("Cast guards: self-correction vs antithesis\n");

// Every one of these is a real Mercer device from the bible: he stops halfway
// through a euphemism, names what he is doing, and starts again. None is an
// antithesis. All must survive the rewrite loop untouched.
const MERCER_SELF_CORRECTION = [
  "No — hold on. I'm doing it again. I'm explaining it like that excuses it.",
  "They called it a communication issue. I called it a communication issue.",
  "The room had concerns. God, listen to me.",
  "It was a football deci— it was a decision made by four people who were scared.",
  "I keep saying we. I wasn't we. I was in the hallway.",
  "Everybody signed off. That's the sentence. I've said that sentence.",
  "He wasn't a fit. Sorry. He was expensive and somebody needed a reason.",
  "I'd like to tell you I said something. I nodded.",
  "That's the public version.",
  "You're right about the result. You're wrong about who paid for it.",
];

// Controls: real antithesis. If these stop being caught the detector has been
// broken in the other direction and this test is no longer meaningful.
const REAL_ANTITHESIS = [
  "That is not a rebuild, that is a fire sale.",
  "That wasn't effort. That was a coaching decision.",
  "This isn't about money, it's about respect.",
  "Not a slump, a collapse.",
];

check("Mercer's mid-sentence self-correction is NEVER flagged as antithesis", () => {
  const wrong: string[] = [];
  for (const line of MERCER_SELF_CORRECTION) {
    const hits = findAntithesis(line);
    if (hits.length > 0) wrong.push(`${line}  → ${hits.map((h) => h.kind).join(",")}`);
  }
  assert(
    wrong.length === 0,
    `the detector must not mistake self-correction for antithesis, but flagged:\n      ${wrong.join("\n      ")}`
  );
});

check("the detector still catches genuine antithesis (control)", () => {
  const missed = REAL_ANTITHESIS.filter((l) => findAntithesis(l).length === 0);
  assert(
    missed.length === 0,
    `these are real antithesis frames and must still be caught:\n      ${missed.join("\n      ")}`
  );
});

check("a self-correction carrying a real antithesis inside it is still caught", () => {
  // The character device does not grant immunity: if he wraps a banned frame in
  // a repair, the frame is still banned.
  const hits = findAntithesis("Sorry — I'm doing it again. That is not a football decision, that is a payroll decision.");
  assert(hits.length > 0, "a repair must not be usable as a wrapper to smuggle antithesis past the detector");
});

// --- performance energy is not seating rank --------------------------------
//
// intensityLevel decides WHICH SEAT a host takes (hostCasting sorts by it).
// Deriving performance energy from it put a loud character in a quiet
// performance. Both directions are pinned: a loud style at a low rank must
// stay big, and a reserved style at a high rank must stay small. The second is
// now the case that matters for the live roster — Cal is the reserved one, and
// a derivation that read his rank instead of his style would hand him assertive
// interruptions and a theatrical kill shot, which is the previous seat-B
// character wearing his name.

check("a LOUD style at intensity 5 derives assertive/natural/theatrical", () => {
  const p = deriveProfileFromHostFields({
    speakingStyle:
      "ENORMOUS trained PA projection. Barked laugh on top of his own punchlines. " +
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

check("Mercer's OWN style text derives a quiet character even before his stored profile is read", () => {
  // Belt and braces. The stored profile is authoritative, but if it ever failed
  // to parse the runtime falls back to this derivation — and the fallback must
  // not resurrect a shouting host. This is the exact style string from the seed.
  const p = deriveProfileFromHostFields({
    slug: "cal-red-eye-mercer",
    intensityLevel: 5,
    speakingStyle:
      "Warm, low, close to the microphone — the register of someone telling you something in a half-empty hotel bar, not addressing a room. Unhurried but never sleepy. Dry humor, understatement, and the occasional self-own. He rarely raises his voice; when he is genuinely angry he gets QUIETER, shorter, and more exact.",
  });
  assert(p.angerStyle === "slower_quieter", `even the DERIVED profile must keep his anger going down, got '${p.angerStyle}'`);
  assert(p.baselineIntensity < p.peakIntensity, "a derived profile must still open below its ceiling");
  assert(p.peakIntensity <= 5, `a derived peak must not exceed his rank, got ${p.peakIntensity}`);
});

check("intensityLevel is still the fallback when the style text is silent", () => {
  const hot = deriveProfileFromHostFields({ speakingStyle: "talks about sports", intensityLevel: 9 });
  assert(hot.interruptionBehavior === "assertive" && hot.killShotBehavior === "theatrical", "a silent style at a high rank falls back to hot");
  const calm = deriveProfileFromHostFields({ speakingStyle: "talks about sports", intensityLevel: 3 });
  assert(calm.interruptionBehavior === "rare" && calm.killShotBehavior === "measured", "a silent style at a low rank falls back to calm");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
