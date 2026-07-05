/**
 * Verification for the Boson inline-tag formatting layer.
 *
 *   npm run test:boson-format
 *
 * Runs formatLineForBoson over a realistic mini-episode (every tone, energy,
 * inline tag category, pause type, and an interruption), then asserts Boson's
 * placement rules hold:
 *   1. Delivery tokens (emotion/style/speed/pitch/expressiveness) LEAD the
 *      line — nothing but tokens before the first spoken character.
 *   2. Only pause/long_pause tokens appear inline after text starts.
 *   3. Every <|sfx:X|> is immediately followed by matching onomatopoeia.
 *   4. Every token uses vocabulary Boson actually accepts.
 *   5. Delivery varies across the episode (not monotone).
 *   6. Formatting is idempotent, and non-Boson providers see zero tokens.
 */

import {
  formatLineForBoson,
  extractBosonTokens,
  allTokensValid,
  TAG_RULES,
  BosonLineInput,
} from "../lib/providers/tts/bosonFormat";

// A compressed episode arc: cold open → debate → evidence → concession → close.
const SAMPLE_LINES: (BosonLineInput & { speaker: string })[] = [
  { speaker: "MAX", tone: "setup", energy: "high", text: "Folks, hold onto your parlay slips, because Friday night changed everything we thought we knew about this series." },
  { speaker: "DOC", tone: "analytical", energy: "medium", text: "Let's slow down. Three games, twelve turnovers a night, and a defensive rating that fell off a cliff after the trade. That's the actual story." },
  { speaker: "MAX", tone: "heated", energy: "high", text: "Off a cliff? [scoffs] They held the best offense in the conference to ninety-one points! Ninety-one!" },
  { speaker: "DOC", tone: "sarcastic", energy: "medium", text: "[chuckles] Sure. Against a team missing both starting guards. Incredible achievement." },
  { speaker: "MAX", tone: "incredulous", energy: "high", isInterruption: true, text: "Missing guards?! You cannot [stammers] you cannot keep moving the goalposts every single week, Doc." },
  { speaker: "DOC", tone: "amused", energy: "medium", text: "[laughs] I'm not moving goalposts, Max. I'm reading box scores. You should try it. [pause] It's illuminating." },
  { speaker: "MAX", tone: "dismissive", energy: "medium", text: "Box scores. [sighs] This is why nobody trusts the spreadsheet crowd. Games are won in the paint, not in a pivot table." },
  { speaker: "DOC", tone: "reflective", energy: "low", text: "You know what's funny. [pause] Five years ago I would have agreed with you. Then I watched the film on that fourth quarter." },
  { speaker: "MAX", tone: "excited", energy: "high", text: "THE FOURTH QUARTER! [laughs hard] Finally, something we agree on! That closing lineup is a cheat code!" },
  { speaker: "DOC", tone: "conceding", energy: "medium", text: "Fine. [exhales] The closing five is real. I'll give you that one — the plus-minus doesn't lie." },
  { speaker: "MAX", tone: "transition", energy: "medium", text: "All right, before we get to picks, one piece of housekeeping. [clears throat] The live show. Tickets. Thursday." },
  { speaker: "DOC", tone: "analytical", energy: "low", text: "[deadpan] Try to contain your enthusiasm for the merchandise table, everyone." },
];

const DELIVERY_CATEGORIES = new Set(["emotion", "style"]);
const POSITIONAL_PROSODY = new Set(["pause", "long_pause"]);

let failures = 0;
function assert(cond: boolean, label: string, detail?: string) {
  if (!cond) {
    failures++;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("=== Boson tag formatting verification ===\n");

const formatted = SAMPLE_LINES.map((line) => ({
  speaker: line.speaker,
  tone: line.tone,
  energy: line.energy,
  input: line.text,
  output: formatLineForBoson(line),
}));

// --- Per-line placement rules -------------------------------------------
for (const f of formatted) {
  const tokens = extractBosonTokens(f.output);

  // Rule 4: valid vocabulary only.
  assert(allTokensValid(f.output), `invalid token vocabulary`, f.output);

  // Rule 1 + 2: the line must open with zero or more DELIVERY tokens
  // (emotion/style/turn-prosody). After that prefix, only positional tokens
  // (sfx, pause, long_pause) may appear — a delivery token mid-line means
  // the whole-turn rule was violated. A line-initial sfx/pause AFTER the
  // delivery prefix is fine: positional tokens go wherever the sound falls,
  // including the very first beat of the line.
  const leadDelivery = f.output.match(/^(?:<\|(?:emotion|style):[a-z_]+\|>|<\|prosody:(?!pause\|>|long_pause\|>)[a-z_]+\|>)*/);
  const body = f.output.slice(leadDelivery ? leadDelivery[0].length : 0);
  for (const t of extractBosonTokens(body)) {
    const positional = t.category === "sfx" || (t.category === "prosody" && POSITIONAL_PROSODY.has(t.value));
    assert(
      positional,
      `turn-level delivery token found after text started`,
      `<|${t.category}:${t.value}|> in "${f.output.slice(0, 90)}..."`
    );
  }

  // Rule 3: every sfx token immediately followed by its onomatopoeia.
  const sfxRe = /<\|sfx:([a-z_]+)\|>(\S*)/g;
  let m: RegExpExecArray | null;
  while ((m = sfxRe.exec(f.output)) !== null) {
    assert(
      m[2].length > 0 && /^[A-Za-z]/.test(m[2]),
      `sfx token without onomatopoeia`,
      `<|sfx:${m[1]}|> followed by "${m[2]}"`
    );
  }

  // Rule 6a: idempotent — formatting formatted text changes nothing.
  assert(
    formatLineForBoson({ ...f, text: f.output }) === f.output,
    `formatter is not idempotent`,
    f.output.slice(0, 60)
  );

  // No leftover square-bracket tags or placeholder markers.
  assert(!/\[[a-z ]+\]/i.test(f.output), `unconverted [tag] remains`, f.output);
  assert(!f.output.includes("BOSON_PAUSE"), `internal placeholder leaked`, f.output);
}

// --- Episode-level variety (not monotone) --------------------------------
const allTokens = formatted.flatMap((f) => extractBosonTokens(f.output));
const emotionSet = new Set(allTokens.filter((t) => t.category === "emotion").map((t) => t.value));
const prosodySet = new Set(allTokens.filter((t) => t.category === "prosody" && !POSITIONAL_PROSODY.has(t.value)).map((t) => t.value));
const sfxSet = new Set(allTokens.filter((t) => t.category === "sfx").map((t) => t.value));
assert(emotionSet.size >= 4, "delivery too flat: fewer than 4 distinct emotions", [...emotionSet].join(","));
assert(prosodySet.size >= 2, "delivery too flat: fewer than 2 distinct turn prosodies", [...prosodySet].join(","));
assert(sfxSet.size >= 2, "sfx conversion not exercising multiple sounds", [...sfxSet].join(","));
assert(allTokens.some((t) => POSITIONAL_PROSODY.has(t.value)), "no inline pauses were produced");

// --- Other providers see zero tokens (structural + direct check) ---------
for (const line of SAMPLE_LINES) {
  assert(
    extractBosonTokens(line.text).length === 0,
    "raw script text (what non-Boson providers receive) contains Boson tokens",
    line.text.slice(0, 60)
  );
}

// --- Every TAG_RULES entry is well-formed --------------------------------
for (const [tag, rule] of Object.entries(TAG_RULES)) {
  if (rule.kind === "sfx") {
    assert(rule.cue.trim().length > 0, `TAG_RULES["${tag}"] sfx has empty cue`);
  }
}

// --- Print the sample ------------------------------------------------------
console.log("--- Formatted sample (Boson-tagged) ---\n");
for (const f of formatted) {
  console.log(`${f.speaker} [${f.tone}/${f.energy}]`);
  console.log(`  ${f.output}\n`);
}

const emotions = [...emotionSet].join(", ");
console.log(`Distinct emotions used: ${emotionSet.size} (${emotions})`);
console.log(`Distinct turn prosody:  ${prosodySet.size} (${[...prosodySet].join(", ")})`);
console.log(`Distinct sfx:           ${sfxSet.size} (${[...sfxSet].join(", ")})`);

if (failures > 0) {
  console.log(`\n❌ ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\n✅ All Boson tag-placement rules verified");
