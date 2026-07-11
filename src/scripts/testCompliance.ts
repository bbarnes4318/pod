// Gambling-compliance guardrail test. Run: npm run test:compliance
//
// Regression for the self-inflicted false positive: the MANDATORY responsible-
// gaming disclaimer contains the word "guarantee" ("...not a prediction,
// guarantee, or recommendation to place a wager"), which the old profit-promise
// regex (optional profit word) flagged — making every betting episode
// unpublishable. The gate must (a) pass its own disclaimer and (b) still catch
// real profit-promise language. Pure: no DB/LLM.

import {
  scanProhibitedGamblingLanguage,
  RESPONSIBLE_GAMBLING_DISCLAIMER,
  checkGamblingCompliance,
} from "../lib/services/compliance";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(cond: boolean, msg: string) { if (!cond) throw new Error(msg); }

function main() {
  console.log("Gambling compliance:");

  check("the mandatory disclaimer passes its OWN prohibited-language scan", () => {
    const hits = scanProhibitedGamblingLanguage(RESPONSIBLE_GAMBLING_DISCLAIMER);
    assert(hits.length === 0, `disclaimer must not self-flag, got ${JSON.stringify(hits)}`);
  });

  check("a betting episode WITH the disclaimer and no bad language is compliant", () => {
    const res = checkGamblingCompliance({
      betting: true,
      showNotes: `Great debate about the sweep.\n\n${RESPONSIBLE_GAMBLING_DISCLAIMER}`,
      marketingText: `Yankees in trouble?\nA nostalgia brawl.\n${RESPONSIBLE_GAMBLING_DISCLAIMER}`,
    });
    assert(res.compliant, `should be compliant, got ${JSON.stringify(res.reasons)}`);
  });

  check("real profit-promise language is STILL caught", () => {
    for (const bad of ["guaranteed win tonight", "guarantee profit every week", "guaranteed payout", "risk-free bet", "can't lose parlay", "easy money lock", "get rich quick"]) {
      const hits = scanProhibitedGamblingLanguage(bad);
      assert(hits.length > 0, `expected a hit for ${JSON.stringify(bad)}`);
    }
  });

  check("a betting episode MISSING the disclaimer is blocked", () => {
    const res = checkGamblingCompliance({ betting: true, showNotes: "No disclaimer here.", marketingText: "Bet big!" });
    assert(!res.compliant && !res.disclaimerPresent, "missing disclaimer must block");
  });

  check("non-betting content is unaffected", () => {
    const res = checkGamblingCompliance({ betting: false, showNotes: "guaranteed win", marketingText: "guaranteed win" });
    assert(res.compliant, "non-betting is never gated");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
