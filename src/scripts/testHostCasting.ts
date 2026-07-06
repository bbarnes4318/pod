// Host-casting decoupling test. Run: npm run test:host-casting
//
// Proves the pipeline is no longer hardcoded to "Max Voltage" / "Dr. Linebreak":
// the speaker matchers and script validation accept whatever two hosts an
// episode is cast with. Pure (no DB/ffmpeg) — exercises makeSpeakerMatchers
// and validateScriptContent with arbitrary host names.

import { makeSpeakerMatchers } from "../lib/services/hostCastingShared";
import { validateScriptContent } from "../lib/services/scriptValidation";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n      ${(err as Error).message}`);
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// Two entirely custom hosts — nothing to do with the seeded duo.
const HOST_A = { id: "host-a-uuid", name: "Riley Storm" };
const HOST_B = { id: "host-b-uuid", name: "Casey Quant" };

/** A minimal valid two-host script with the given cast, 42 lines, balanced. */
function makeScript(aName: string, aId: string, bName: string, bId: string) {
  const lines = Array.from({ length: 42 }, (_, i) => {
    const isA = i % 2 === 0;
    return {
      lineIndex: i,
      speakerName: isA ? aName : bName,
      speakerHostId: isA ? aId : bId,
      text: "This is a perfectly ordinary spoken debate line about last night's game.",
      tone: "analytical",
      energy: "medium",
      isFactualClaim: false,
      needsHumanReview: false,
      evidenceRefs: [],
    };
  });
  return { segments: [{ type: "topic", title: "Topic", lines }] };
}

function main() {
  console.log("Speaker matchers:");
  const speakers = makeSpeakerMatchers({ hostA: HOST_A, hostB: HOST_B });

  check("accepts either cast host by name (case-insensitive)", () => {
    assert(speakers.isValidSpeaker("Riley Storm"), "host A name should be valid");
    assert(speakers.isValidSpeaker("casey quant"), "host B name (lowercased) should be valid");
    assert(speakers.hostForSpeaker("Riley Storm")?.id === "host-a-uuid", "resolves to host A id");
    assert(speakers.expectedHostId("Casey Quant") === "host-b-uuid", "expected host id for B");
  });

  check("rejects the old hardcoded names when not cast", () => {
    assert(!speakers.isValidSpeaker("Max Voltage"), "Max Voltage must NOT be valid for a custom cast");
    assert(!speakers.isValidSpeaker("Dr. Linebreak"), "Dr. Linebreak must NOT be valid for a custom cast");
    assert(speakers.hostForSpeaker("Nobody") === null, "unknown speaker resolves to null");
  });

  console.log("Script validation with a custom cast:");

  check("a balanced script cast with custom hosts passes speaker checks", () => {
    const content = makeScript("Riley Storm", "host-a-uuid", "Casey Quant", "host-b-uuid");
    const summary = validateScriptContent(content, {
      allowedSourceRefs: new Set<string>(),
      hostA: { id: "host-a-uuid", name: "Riley Storm" },
      hostB: { id: "host-b-uuid", name: "Casey Quant" },
      unsafeClaims: [],
    });
    assert(summary.invalidSpeakerCount === 0, `expected 0 invalid speakers, got ${summary.invalidSpeakerCount}: ${summary.reasons.join("; ")}`);
    assert(summary.hostLineShare["Riley Storm"] === 50, `Riley share should be 50, got ${summary.hostLineShare["Riley Storm"]}`);
    assert(summary.hostLineShare["Casey Quant"] === 50, `Casey share should be 50`);
    // No speaker-balance or speaker-name reasons should appear.
    assert(!summary.reasons.some((r) => r.includes("Invalid speakerName")), "no invalid-speaker reason");
    assert(!summary.reasons.some((r) => r.includes("unbalanced")), "no imbalance reason");
  });

  check("the OLD hardcoded names are now REJECTED under a custom cast", () => {
    // Same script but speakers still say Max/Dr — must fail against the custom cast.
    const content = makeScript("Max Voltage", "host-a-uuid", "Dr. Linebreak", "host-b-uuid");
    const summary = validateScriptContent(content, {
      allowedSourceRefs: new Set<string>(),
      hostA: { id: "host-a-uuid", name: "Riley Storm" },
      hostB: { id: "host-b-uuid", name: "Casey Quant" },
      unsafeClaims: [],
    });
    assert(summary.invalidSpeakerCount === 42, `every Max/Dr line should be invalid under a Riley/Casey cast, got ${summary.invalidSpeakerCount}`);
    assert(
      summary.reasons.some((r) => r.includes("Riley Storm") && r.includes("Casey Quant")),
      "error should name the cast hosts, not Max/Dr"
    );
  });

  check("wrong speakerHostId is caught even with a valid name", () => {
    const content = makeScript("Riley Storm", "WRONG-ID", "Casey Quant", "host-b-uuid");
    const summary = validateScriptContent(content, {
      allowedSourceRefs: new Set<string>(),
      hostA: { id: "host-a-uuid", name: "Riley Storm" },
      hostB: { id: "host-b-uuid", name: "Casey Quant" },
      unsafeClaims: [],
    });
    assert(summary.invalidSpeakerCount > 0, "mismatched speakerHostId must be flagged");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
