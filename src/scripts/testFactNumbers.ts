// Number-in-evidence verification test. Run: npm run test:fact-numbers
//
// Locks in FIX 1 — the deterministic check that a factual line's stated figures
// actually appear in its cited evidence (closing the "real ref on an inflated
// number" blind spot that let v3/v4 pass at 100% coverage while asserting "five
// homers" against evidence that says three). Pure: no DB, no LLM.

import { verifyClaimFigures, extractAssertedFigures, extractEvidenceNumbers } from "../lib/services/factNumbers";

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

function main() {
  console.log("Number-in-evidence verification:");

  // --- The three required cases ---
  check("KNOWN CASE: 'five homers' FAILS against evidence that says three", () => {
    const v = verifyClaimFigures(
      "Five homers on the night — five! Detroit hadn't done that since twenty-eighteen.",
      "Detroit hit three first-inning home runs (Carpenter, Greene, Torkelson) in the 9-3 win."
    );
    assert(v.verifiable, "should be verifiable");
    const vals = v.unsupportedFigures.map((f) => f.value);
    assert(vals.includes(5), `expected 5 flagged, got ${JSON.stringify(vals)}`);
    const five = v.unsupportedFigures.find((f) => f.value === 5)!;
    assert(five.evidenceSays.includes(3), `reason should surface evidence's 3, got ${JSON.stringify(five.evidenceSays)}`);
  });

  check("KNOWN CASE: 'three 100-loss seasons' FAILS (100 absent from evidence)", () => {
    const v = verifyClaimFigures(
      "These are people who sat through three 100-loss seasons. Three!",
      "Orioles fans booed the rookie starter after another home loss dropped them further in the standings."
    );
    assert(v.verifiable, "verifiable");
    const vals = v.unsupportedFigures.map((f) => f.value);
    assert(vals.includes(100), `expected 100 flagged, got ${JSON.stringify(vals)}`);
  });

  check("spoken year 'twenty twenty-three' => 2023 (not a bare 20), flagged if absent", () => {
    const v = verifyClaimFigures(
      "Longest skid since twenty twenty-three.",
      "The team's recent slide is their worst in a while; they entered 9-11 over the stretch."
    );
    const vals = v.unsupportedFigures.map((f) => f.value);
    assert(vals.includes(2023), `expected 2023 flagged, got ${JSON.stringify(vals)}`);
    assert(!vals.includes(20), `must NOT flag a bare 20 from a spoken year, got ${JSON.stringify(vals)}`);
  });

  check("composite with 'and': 'seventeen thousand five hundred and eighty-one' => 17581", () => {
    const figs = extractAssertedFigures("Seventeen thousand five hundred and eighty-one showed up.");
    assert(figs.some((f) => f.value === 17581), `expected 17581, got ${JSON.stringify(figs.map((f) => f.value))}`);
    const supported = verifyClaimFigures("Seventeen thousand five hundred and eighty-one showed up.", "Announced attendance: 17,581.");
    assert(supported.unsupportedFigures.length === 0, `17,581 should match, got ${JSON.stringify(supported.unsupportedFigures)}`);
  });

  check("composite 'seventeen thousand five hundred' => 17500 (not bare 1000)", () => {
    const supported = verifyClaimFigures(
      "Seventeen thousand five hundred paid to get in.",
      "Announced attendance was 17,500 at the gate."
    );
    assert(supported.unsupportedFigures.length === 0, `17,500 should match evidence 17,500, got ${JSON.stringify(supported.unsupportedFigures)}`);
    const absent = verifyClaimFigures("Seventeen thousand five hundred paid to get in.", "The crowd was sparse and quiet.");
    assert(absent.unsupportedFigures.some((f) => f.value === 17500), `expected 17500 flagged, got ${JSON.stringify(absent.unsupportedFigures)}`);
    assert(!absent.unsupportedFigures.some((f) => f.value === 1000), "must not flag a bare 1000");
  });

  check("KNOWN CASE: '48-38, second in the East' PASSES (present in evidence)", () => {
    const v = verifyClaimFigures(
      "They're 48-38, second in the East — that's a real team.",
      "The team sits at 48-38, good for second in the East entering the weekend."
    );
    assert(v.verifiable, "verifiable");
    assert(v.unsupportedFigures.length === 0, `expected no unsupported figures, got ${JSON.stringify(v.unsupportedFigures)}`);
  });

  // --- Must NOT false-fail legitimate rounding (writer is told to round) ---
  check("rounding OK: 'damn near fifty percent' supports evidence 49.8%", () => {
    const v = verifyClaimFigures("He's shooting damn near fifty percent from deep.", "Three-point percentage: 49.8% on the season.");
    assert(v.unsupportedFigures.every((f) => f.value !== 50), `50 should be within tolerance of 49.8, got ${JSON.stringify(v.unsupportedFigures)}`);
  });

  check("exact spelled/digit match: 'thirty-one points' supports evidence '31'", () => {
    const v = verifyClaimFigures("Thirty-one points a night and still snubbed.", "Averaging 31 points per game.");
    assert(v.unsupportedFigures.length === 0, `expected supported, got ${JSON.stringify(v.unsupportedFigures)}`);
  });

  check("inflation caught even near a real number: 'seven years' when evidence says 2018 only", () => {
    const v = verifyClaimFigures("Seven years since they did it.", "Last accomplished in 2018.");
    assert(v.unsupportedFigures.some((f) => f.value === 7), "7 is not supported by 2018");
  });

  // --- Degrade, never silently pass ---
  check("degrade: empty evidence => verifiable=false (leave it to semantic)", () => {
    const v = verifyClaimFigures("They went 5-and-15 since June.", "");
    assert(v.verifiable === false, "no evidence text => not verifiable");
    assert(v.unsupportedFigures.length === 0, "must not fabricate a failure with no evidence");
  });

  check("'5-and-15 since June' FAILS when the record is absent from evidence", () => {
    const v = verifyClaimFigures("They're 5-and-15 since the middle of June — fifty-six runs, worst in the sport.", "The team has struggled recently, losing more than they've won since the break.");
    const vals = v.unsupportedFigures.map((f) => f.value);
    assert(vals.includes(5) && vals.includes(15), `expected 5 and 15 flagged, got ${JSON.stringify(vals)}`);
    assert(vals.includes(56), `expected 56 runs flagged, got ${JSON.stringify(vals)}`);
  });

  // --- FIX 2: named-person attribution (Boone / Michael Kay cases) ---
  const H = { checkAttributions: true, hostNames: ["Louie", "Mickey"] };
  check("attribution: invented quote 'Michael Kay's callin' it a disaster' FAILS", () => {
    const v = verifyClaimFigures("Even Michael Kay's callin' it a disaster down there.", "The team lost again at home; the fans booed.", H);
    assert(v.unsupportedAttributions.some((n) => /kay/i.test(n)), `expected Kay flagged, got ${JSON.stringify(v.unsupportedAttributions)}`);
  });

  check("attribution: possessive action 'Boone's decision' FAILS when Boone absent", () => {
    const v = verifyClaimFigures("And Boone's decision in the tenth cost 'em the game.", "The team lost in extra innings.", H);
    assert(v.unsupportedAttributions.some((n) => /boone/i.test(n)), `expected Boone flagged, got ${JSON.stringify(v.unsupportedAttributions)}`);
  });

  check("attribution: GENERAL reference 'Boone's bullpen management' is ALLOWED", () => {
    const v = verifyClaimFigures("Boone's bullpen management is the whole story here.", "The bullpen has struggled all month.", H);
    assert(v.unsupportedAttributions.length === 0, `general reference must not flag, got ${JSON.stringify(v.unsupportedAttributions)}`);
  });

  check("attribution: a person IN evidence passes even with a quote", () => {
    const v = verifyClaimFigures("Boone said the pen's gotta be better.", "Manager Aaron Boone said the bullpen has to be better after the loss.", H);
    assert(!v.unsupportedAttributions.some((n) => /boone/i.test(n)), "Boone is in the evidence");
  });

  // sanity on the primitives
  check("extractor sanity", () => {
    assert(extractEvidenceNumbers("three homers, 48-38").includes(3), "spelled three");
    assert(extractEvidenceNumbers("three homers, 48-38").includes(48), "digit 48");
    assert(extractAssertedFigures("five bombs").some((f) => f.value === 5), "five => 5");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
